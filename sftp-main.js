// SFTP backend: file listing/ops for the local disk and any saved host, plus streamed transfers between any two of them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Client } = require('ssh2');
const { makeS3 } = require('./s3-ops');
const { friendly } = require('./hostkeys');

const sessions = new Map(); // id -> { ops, close, client? (ssh only), restore? (s3 only) }
const jobs = new Map(); // jobId -> AbortController

const posix = path.posix;

function remoteOps(sftp) {
  const c = (m, ...a) => new Promise((res, rej) => sftp[m](...a, (e, r) => (e ? rej(e) : res(r))));
  return {
    sep: '/',
    join: (a, b) => posix.join(a, b),
    basename: posix.basename,
    parent: (d) => (d === '/' ? null : posix.dirname(d)),
    async home() { return c('realpath', '.'); },
    async normalize(d) { return c('realpath', d); },
    async list(dir) {
      const items = await c('readdir', dir);
      return Promise.all(items.filter((i) => i.filename !== '.' && i.filename !== '..').map(async (i) => {
        let isDir = i.attrs.isDirectory();
        if (i.attrs.isSymbolicLink()) isDir = await c('stat', posix.join(dir, i.filename)).then((s) => s.isDirectory(), () => false);
        return { name: i.filename, size: i.attrs.size, mtime: i.attrs.mtime * 1000, isDir };
      }));
    },
    async stat(p) { const s = await c('stat', p); return { isDir: s.isDirectory(), size: s.size }; },
    mkdir: (p) => c('mkdir', p),
    rename: (a, b) => c('rename', a, b),
    async remove(p) {
      const s = await c('lstat', p);
      if (s.isDirectory()) {
        for (const i of await c('readdir', p)) if (i.filename !== '.' && i.filename !== '..') await this.remove(posix.join(p, i.filename));
        await c('rmdir', p);
      } else await c('unlink', p);
    },
    read: (p) => sftp.createReadStream(p),
    write: (p) => sftp.createWriteStream(p),
  };
}

const localOps = {
  sep: path.sep,
  join: (a, b) => (a === '' ? b : path.join(a, b)),
  basename: path.basename,
  parent: (d) => (d === '' ? null : path.dirname(d) === d ? '' : path.dirname(d)),
  async home() { return os.homedir(); },
  async normalize(d) { return d === '' ? '' : path.resolve(d); },
  async list(dir) {
    if (dir === '') { // Windows: show the drives
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        if (fs.existsSync(d)) drives.push({ name: d, size: 0, mtime: 0, isDir: true });
      }
      return drives;
    }
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    return Promise.all(ents.map(async (d) => {
      try {
        const s = await fs.promises.stat(path.join(dir, d.name));
        return { name: d.name, size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() };
      } catch { return { name: d.name, size: 0, mtime: 0, isDir: d.isDirectory() }; }
    }));
  },
  async stat(p) { const s = await fs.promises.stat(p); return { isDir: s.isDirectory(), size: s.size }; },
  mkdir: (p) => fs.promises.mkdir(p),
  rename: (a, b) => fs.promises.rename(a, b),
  remove: (p) => fs.promises.rm(p, { recursive: true, force: true }),
  read: (p) => fs.createReadStream(p),
  write: (p) => fs.createWriteStream(p),
};

const opsFor = (id) => {
  if (id === 'local') return localOps;
  const s = sessions.get(id);
  if (!s) throw new Error('SFTP connection is closed');
  return s.ops;
};

async function totalSize(ops, p) {
  const s = await ops.stat(p);
  if (!s.isDir) return s.size;
  let n = 0;
  for (const e of await ops.list(p)) n += await totalSize(ops, ops.join(p, e.name));
  return n;
}

async function copyTree(src, dst, srcPath, dstDir, st) {
  if (st.signal.aborted) throw new Error('Cancelled');
  const s = await src.stat(srcPath);
  const target = dst.join(dstDir, src.basename(srcPath));
  if (s.isDir) {
    try { await dst.mkdir(target); } catch (e) {
      if (!(await dst.stat(target).then((x) => x.isDir, () => false))) throw e; // already existing folder is fine
    }
    for (const e of await src.list(srcPath)) await copyTree(src, dst, src.join(srcPath, e.name), target, st);
    return;
  }
  st.file = src.basename(srcPath);
  const rs = src.read(srcPath);
  rs.on('data', (b) => { st.done += b.length; st.emit(); });
  await pipeline(rs, dst.write(target, s.size), { signal: st.signal });
}

function register(ipcMain, hostConfig, s3Config) {
  ipcMain.handle('sftp:open', (e, id, hostId) => new Promise((resolve) => {
    const hc = hostConfig(hostId);
    if (hc.error) return resolve({ error: hc.error });
    const client = new Client();
    client.on('ready', () => client.sftp((err, sftp) => {
      if (err) { client.end(); return resolve({ error: err.message }); }
      sessions.set(id, { client, ops: remoteOps(sftp), close: () => client.end() });
      resolve({ ok: true });
    }));
    client.on('error', (err) => resolve({ error: friendly(err.message) }));
    client.on('close', () => {
      if (sessions.delete(id) && !e.sender.isDestroyed()) e.sender.send('sftp:closed', id);
    });
    client.connect(hc.cfg);
  }));

  ipcMain.handle('sftp:close', (_, id) => { sessions.get(id)?.close(); sessions.delete(id); });

  ipcMain.handle('sftp:openS3', async (_, id, s3id) => {
    const cfg = s3Config(s3id);
    if (!cfg) return { error: 'S3 connection not found (is the vault unlocked?)' };
    const s3 = makeS3(cfg);
    try { await s3.test(); } catch (e) { s3.close(); return { error: e.message }; }
    sessions.set(id, { ops: s3.ops, restore: s3.restore, close: s3.close });
    return { ok: true };
  });

  const wrap = (fn) => async (...args) => { try { return await fn(...args); } catch (err) { return { error: err.message }; } };

  ipcMain.handle('sftp:list', wrap(async (_, id, dir) => {
    const ops = opsFor(id);
    const cur = dir == null ? await ops.home() : await ops.normalize(dir);
    return { path: cur, sep: ops.sep, parent: ops.parent(cur), entries: await ops.list(cur) };
  }));
  ipcMain.handle('sftp:mkdir', wrap(async (_, id, dir, name) => { await opsFor(id).mkdir(opsFor(id).join(dir, name)); return {}; }));
  ipcMain.handle('sftp:rename', wrap(async (_, id, dir, from, to) => { const o = opsFor(id); await o.rename(o.join(dir, from), o.join(dir, to)); return {}; }));
  ipcMain.handle('sftp:remove', wrap(async (_, id, dir, names) => {
    const o = opsFor(id);
    for (const n of names) await o.remove(o.join(dir, n));
    return {};
  }));

  // Streams data straight from the source to the destination, so server-to-server copies need no temp files.
  ipcMain.handle('sftp:transfer', (e, jobId, srcId, srcPaths, dstId, dstDir) => {
    let src, dst;
    try { src = opsFor(srcId); dst = opsFor(dstId); } catch (err) { return { error: err.message }; }
    const ac = new AbortController();
    jobs.set(jobId, ac);
    const send = (ch, payload) => { if (!e.sender.isDestroyed()) e.sender.send(ch, jobId, payload); };
    const st = { done: 0, total: 0, file: '', signal: ac.signal, last: 0 };
    st.emit = (force) => {
      const now = Date.now();
      if (force || now - st.last > 150) { st.last = now; send('sftp:progress', { done: st.done, total: st.total, file: st.file }); }
    };
    (async () => {
      for (const p of srcPaths) st.total += await totalSize(src, p);
      st.emit(true);
      for (const p of srcPaths) await copyTree(src, dst, p, dstDir, st);
    })().then(
      () => send('sftp:done', {}),
      (err) => send('sftp:done', { error: ac.signal.aborted ? 'Cancelled' : err.message }),
    ).finally(() => jobs.delete(jobId));
    return { ok: true };
  });
  ipcMain.handle('sftp:cancel', (_, jobId) => jobs.get(jobId)?.abort());

  ipcMain.handle('sftp:restore', wrap(async (_, id, paths, days, tier) => {
    const s = sessions.get(id);
    if (!s?.restore) throw new Error('Restore only works on S3 connections');
    return s.restore(paths, days, tier);
  }));

  // Runs shell commands on the server of an open SSH/SFTP connection (WinSCP-style custom commands), streaming the output.
  const execs = new Map(); // jobId -> cancel()
  ipcMain.handle('sftp:exec', (e, jobId, id, cmds) => {
    const s = sessions.get(id);
    if (!s?.client) return { error: 'Commands can only run on SSH servers' };
    const send = (ch, payload) => { if (!e.sender.isDestroyed()) e.sender.send(ch, jobId, payload); };
    let cancelled = false, current = null;
    execs.set(jobId, () => { cancelled = true; try { current?.signal('TERM'); current?.close(); } catch { /* already closed */ } });
    const runOne = (command) => new Promise((resolve) => {
      s.client.exec(command, (err, ch) => {
        if (err) { send('sftp:execOut', `Error: ${err.message}
`); return resolve(1); }
        current = ch;
        ch.setEncoding('utf8');
        ch.stderr.setEncoding('utf8');
        ch.on('data', (t) => send('sftp:execOut', t));
        ch.stderr.on('data', (t) => send('sftp:execOut', t));
        ch.on('close', (code, signal) => resolve(code ?? (signal ? 143 : 1)));
        ch.end(); // no stdin, so a command that reads input sees EOF instead of hanging
      });
    });
    (async () => {
      let worst = 0;
      for (const c of cmds) {
        if (cancelled) break;
        send('sftp:execOut', `
$ ${c.show}
`);
        const code = await runOne(c.run);
        if (code !== 0) { worst = code; send('sftp:execOut', `[exit code ${code}]
`); }
      }
      send('sftp:execDone', { code: worst, cancelled });
    })().finally(() => execs.delete(jobId));
    return { ok: true };
  });
  ipcMain.handle('sftp:execCancel', (_, jobId) => execs.get(jobId)?.());
}

module.exports = { register };
