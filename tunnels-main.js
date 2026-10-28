// SSH port forwarding: local (-L), remote (-R) and dynamic SOCKS5 (-D). Each running tunnel owns one SSH connection.
const net = require('net');
const { Client } = require('ssh2');
const { friendly } = require('./hostkeys');

const RETRY_DELAYS = [5, 10, 15, 20, 30]; // seconds, like terminal reconnects

function register(ipcMain, hostConfig, getRule) {
  const running = new Map(); // id -> tunnel state

  const status = (t, state, message = '') => {
    t.state = state;
    if (!t.sender.isDestroyed()) t.sender.send('tunnel:status', t.id, { state, message, conns: t.conns });
  };

  // glue two sockets together and keep the live-connection counter right
  function pipe(t, a, b) {
    t.conns++;
    status(t, t.state, '');
    t.sockets.add(a);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      t.conns--;
      t.sockets.delete(a);
      a.destroy();
      b.destroy();
      if (!t.stopped) status(t, t.state, '');
    };
    a.on('close', end); b.on('close', end);
    a.on('error', end); b.on('error', end);
    a.pipe(b); b.pipe(a);
  }

  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use on this PC`) : e));
    server.listen(port, host, resolve);
  });

  function socks5(t, client) {
    return (sock) => {
      sock.on('error', () => sock.destroy());
      sock.once('data', (d) => {
        if (d[0] !== 5) return sock.destroy();
        sock.write(Buffer.from([5, 0])); // no authentication
        sock.once('data', (req) => {
          const fail = (code) => sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (req[0] !== 5 || req[1] !== 1) return fail(7); // only CONNECT
          let host, off;
          if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); off = 8; }
          else if (req[3] === 3) { host = req.subarray(5, 5 + req[4]).toString(); off = 5 + req[4]; }
          else if (req[3] === 4) { host = Array.from({ length: 8 }, (_, i) => req.readUInt16BE(4 + i * 2).toString(16)).join(':'); off = 20; }
          else return fail(8);
          const port = req.readUInt16BE(off);
          client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, host, port, (err, stream) => {
            if (err) return fail(5);
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            pipe(t, sock, stream);
          });
        });
      });
    };
  }

  async function setup(t, client) {
    const { type, bindHost, bindPort, destHost, destPort } = t.rule;
    const bport = Number(bindPort);
    if (type === 'R') {
      await new Promise((res, rej) => client.forwardIn(bindHost || '127.0.0.1', bport, (e) => (e ? rej(new Error('Server refused the remote port: ' + e.message)) : res())));
      client.on('tcp connection', (info, accept) => {
        const stream = accept();
        const sock = net.connect(Number(destPort), destHost || '127.0.0.1');
        sock.on('connect', () => pipe(t, sock, stream));
        sock.on('error', () => stream.destroy());
      });
      return;
    }
    const server = net.createServer(type === 'D' ? socks5(t, client) : (sock) => {
      client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, destHost || '127.0.0.1', Number(destPort), (err, stream) => {
        if (err) return sock.destroy();
        pipe(t, sock, stream);
      });
    });
    t.server = server;
    await listen(server, bport, bindHost || '127.0.0.1');
  }

  function teardown(t) {
    t.server?.close();
    t.server = null;
    for (const s of t.sockets) s.destroy();
    t.sockets.clear();
    t.conns = 0;
  }

  function connectTunnel(t) {
    return new Promise((resolve) => {
      const hc = hostConfig(t.rule.hostId);
      if (hc.error) return resolve({ error: hc.error });
      const client = new Client();
      t.client = client;
      let up = false;
      client.on('ready', async () => {
        try {
          await setup(t, client);
          up = true;
          status(t, 'running');
          resolve({ ok: true });
        } catch (err) { client.end(); resolve({ error: err.message }); }
      });
      client.on('error', (err) => { if (!up) resolve({ error: friendly(err.message) }); });
      client.on('close', () => {
        teardown(t);
        if (up && !t.stopped) reconnect(t);
      });
      client.connect(hc.cfg);
    });
  }

  async function reconnect(t) {
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      status(t, 'reconnecting', `attempt ${i + 1}/${RETRY_DELAYS.length}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[i] * 1000));
      if (t.stopped) return;
      const r = await connectTunnel(t);
      if (r.ok || t.stopped) return;
      if (/authentication|permission denied|not trusted/i.test(r.error)) { running.delete(t.id); return status(t, 'error', r.error); }
    }
    running.delete(t.id);
    status(t, 'error', 'Server not reachable. Press Start to try again.');
  }

  ipcMain.handle('tunnel:start', async (e, id) => {
    if (running.has(id)) return { ok: true };
    const rule = getRule(id);
    if (!rule) return { error: 'Tunnel not found (is the vault unlocked?)' };
    const t = { id, rule: { ...rule }, sender: e.sender, state: 'starting', conns: 0, stopped: false, sockets: new Set(), server: null, client: null };
    running.set(id, t);
    status(t, 'starting');
    const r = await connectTunnel(t);
    if (r.error) { running.delete(id); return r; }
    return { ok: true };
  });

  function stop(id) {
    const t = running.get(id);
    if (!t) return;
    t.stopped = true;
    running.delete(id);
    teardown(t);
    t.client?.end();
    status(t, 'stopped');
  }
  ipcMain.handle('tunnel:stop', (_, id) => { stop(id); });
  return { stopAll: () => [...running.keys()].forEach(stop) };
}

module.exports = { register };
