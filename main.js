const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, utils } = require('ssh2');
const { convertPpk, isPpk } = require('./ppk');
const { createChecker, friendly } = require('./hostkeys');

const vaultFile = () => path.join(app.getPath('userData'), 'vault.json');
let session = null; // { key, salt, data }

function deriveKey(pw, salt) {
  return crypto.scryptSync(pw, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}
function persist() {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', session.key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(session.data), 'utf8'), c.final()]);
  fs.writeFileSync(vaultFile(), JSON.stringify({
    v: 1,
    salt: session.salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: enc.toString('base64'),
  }));
}
const defaultData = () => ({ hosts: [], keys: [], snippets: [] });

ipcMain.handle('vault:exists', () => fs.existsSync(vaultFile()));
ipcMain.handle('vault:create', (_, pw) => {
  const salt = crypto.randomBytes(16);
  session = { salt, key: deriveKey(pw, salt), data: defaultData() };
  persist();
  return session.data;
});
ipcMain.handle('vault:unlock', (_, pw) => {
  const f = JSON.parse(fs.readFileSync(vaultFile(), 'utf8'));
  const salt = Buffer.from(f.salt, 'base64');
  const key = deriveKey(pw, salt);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const out = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]);
    session = { salt, key, data: JSON.parse(out.toString('utf8')) };
    return session.data;
  } catch {
    return null;
  }
});
ipcMain.handle('vault:save', (_, data) => {
  if (!session) return false;
  session.data = data;
  persist();
  return true;
});
ipcMain.handle('vault:lock', () => { tunnels.stopAll(); session = null; });

// ---- backup: export / import the whole vault as one file protected by its own password ----
function sealJson(obj, pw) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(pw, salt), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, kind: 'sshvault-backup', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') });
}
function openJson(text, pw) {
  const f = JSON.parse(text);
  if (f.kind !== 'sshvault-backup') throw new Error('not a backup');
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(pw, Buffer.from(f.salt, 'base64')), Buffer.from(f.iv, 'base64'));
  d.setAuthTag(Buffer.from(f.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'));
}
// what makes two entries "the same thing" when merging a backup from another computer
const SAME = {
  keys: (x) => x.privateKey,
  hosts: (x) => [x.host, x.port, x.username].join('|'),
  snippets: (x) => x.name + '|' + x.command,
  s3: (x) => [x.bucket, x.accessKeyId, x.endpoint].join('|'),
  commands: (x) => x.command,
  forwards: (x) => [x.type, x.bindHost, x.bindPort, x.destHost, x.destPort].join('|'),
};

// Adds what is missing from a backup. Order matters: keys first, then hosts (which point at keys), then forwards (which point at hosts).
function mergeInto(cur, incoming) {
  const added = {};
  const idMap = {}; // backup id -> id of the equivalent entry we already had
  for (const k of Object.keys(SAME)) {
    const list = (cur[k] ||= []);
    const bySig = new Map(list.map((x) => [SAME[k](x), x]));
    added[k] = 0;
    for (const x of incoming[k] || []) {
      const have = bySig.get(SAME[k](x));
      if (have) { idMap[x.id] = have.id; continue; }
      const copy = { ...x };
      if (k === 'hosts' && copy.keyId) copy.keyId = idMap[copy.keyId] || copy.keyId;
      if (k === 'forwards') copy.hostId = idMap[copy.hostId] || copy.hostId;
      list.push(copy);
      bySig.set(SAME[k](copy), copy);
      added[k]++;
    }
  }
  cur.knownHosts = { ...(incoming.knownHosts || {}), ...(cur.knownHosts || {}) };
  if (!cur.archive && incoming.archive) cur.archive = incoming.archive;
  return added;
}

ipcMain.handle('vault:export', async (e, pw) => {
  if (!session) return { error: 'Vault locked' };
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Export SSHVault backup',
    defaultPath: path.join(app.getPath('documents'), `sshvault-backup-${new Date().toISOString().slice(0, 10)}.sshvault`),
    filters: [{ name: 'SSHVault backup', extensions: ['sshvault'] }],
  });
  if (r.canceled) return { canceled: true };
  fs.writeFileSync(r.filePath, sealJson(session.data, pw));
  return { ok: true, path: r.filePath };
});

ipcMain.handle('vault:import', async (e, pw, mode) => {
  if (!session) return { error: 'Vault locked' };
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Import SSHVault backup',
    properties: ['openFile'],
    filters: [{ name: 'SSHVault backup', extensions: ['sshvault'] }],
  });
  if (r.canceled) return { canceled: true };
  let incoming;
  try { incoming = openJson(fs.readFileSync(r.filePaths[0], 'utf8'), pw); } catch { return { error: 'Wrong password, or this is not an SSHVault backup file' }; }
  const added = {};
  if (mode === 'replace') {
    session.data = { ...defaultData(), ...incoming };
  } else {
    Object.assign(added, mergeInto(session.data, incoming));
  }
  persist();
  return { data: session.data, added };
});
ipcMain.handle('clip:write', (_, t) => clipboard.writeText(t));
ipcMain.handle('clip:read', () => clipboard.readText());

ipcMain.handle('keys:generate', (_, comment) => {
  const k = utils.generateKeyPairSync('ed25519', { comment: comment || 'sshvault' });
  return { privateKey: k.private, publicKey: k.public };
});

ipcMain.handle('keys:pickFiles', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Import SSH private keys',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  return r.filePaths
    .filter((f) => !f.endsWith('.pub'))
    .map((f) => {
      try {
        const st = fs.statSync(f);
        if (st.size > 64 * 1024) return { name: path.basename(f), error: 'File too large to be a key' };
        return { name: path.basename(f), privateKey: fs.readFileSync(f, 'utf8') };
      } catch (err) {
        return { name: path.basename(f), error: err.message };
      }
    });
});

// Validates a private key and derives its public key. Returns needsPassphrase when encrypted.
ipcMain.handle('keys:parse', (_, text, passphrase) => {
  if (isPpk(text)) {
    // PuTTY key: convert to PKCS#8 and make sure ssh2 can use the result
    const r = convertPpk(text, passphrase);
    if (r.error) return r;
    const check = utils.parseKey(r.privateKey);
    return check instanceof Error ? { error: check.message } : r;
  }
  const k = utils.parseKey(text, passphrase || undefined);
  if (k instanceof Error) {
    return { error: k.message, needsPassphrase: /passphrase|encrypted/i.test(k.message) };
  }
  const key = Array.isArray(k) ? k[0] : k;
  return { publicKey: `${key.type} ${key.getPublicSSH().toString('base64')} ${key.comment || ''}`.trim() + '\n' };
});

// ---- live server stats (status bar) ----
// One short-lived exec channel per sample on the existing connection; Linux hosts only.
const STATS_SCRIPT = [
  'hostname', 'echo ---', 'head -1 /proc/stat', 'echo ---',
  'grep -E "^(MemTotal|MemAvailable):" /proc/meminfo', 'echo ---',
  'cat /proc/net/dev', 'echo ---', 'cut -d" " -f1 /proc/uptime', 'echo ---',
  'who | cut -d" " -f1 | sort -u | tr "\\n" " "; echo', 'echo ---',
  'df -P -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs | tail -n +2 | tr -s " " | cut -d" " -f5,6', 'echo ---',
  'whoami', '',
].join('\n');

function parseStats(out, prev) {
  const s = out.split('\n---\n').map((x) => x.trim());
  if (s.length < 8 || !s[1].startsWith('cpu')) return null;
  const nums = s[1].split(/\s+/).slice(1).map(Number);
  const idle = nums[3] + (nums[4] || 0);
  const total = nums.reduce((a, b) => a + b, 0);
  const mem = Object.fromEntries(s[2].split('\n').map((l) => { const m = l.match(/^(\w+):\s+(\d+)/); return [m?.[1], Number(m?.[2]) * 1024]; }));
  let rx = 0, tx = 0;
  for (const l of s[3].split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const p = rest.trim().split(/\s+/).map(Number);
    rx += p[0]; tx += p[8];
  }
  const now = Date.now();
  const raw = { idle, total, rx, tx, now };
  const dt = prev ? (now - prev.now) / 1000 : 0;
  const disks = s[6].split('\n').map((l) => l.split(' ')).filter((d) => d.length === 2)
    .map(([pct, mount]) => ({ mount, pct: parseInt(pct, 10) }));
  return {
    raw,
    view: {
      host: s[0],
      cpu: prev && total > prev.total ? Math.max(0, Math.min(100, 100 * (1 - (idle - prev.idle) / (total - prev.total)))) : 0,
      memUsed: mem.MemTotal - mem.MemAvailable,
      memTotal: mem.MemTotal,
      down: dt ? Math.max(0, (rx - prev.rx) / dt) : 0,
      up: dt ? Math.max(0, (tx - prev.tx) / dt) : 0,
      uptime: Number(s[4]),
      users: s[5].split(/\s+/).filter(Boolean),
      me: s[7],
      disks,
    },
  };
}

function startStats(c, send) {
  let prev = null, busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    c.exec('sh -s', (err, ch) => {
      if (err) { busy = false; return; }
      let out = '';
      ch.on('data', (d) => { out += d; });
      ch.stderr.on('data', () => {});
      ch.on('close', () => {
        busy = false;
        try {
          const r = parseStats(out, prev);
          if (r) { prev = r.raw; send('ssh:stats', r.view); }
        } catch { /* not a Linux host or odd output: skip this sample */ }
      });
      ch.end(STATS_SCRIPT);
    });
  };
  tick();
  return setInterval(tick, 3000);
}

const conns = new Map();
const checkHostKey = createChecker({
  getData: () => session?.data,
  save: () => persist(),
  ask: async ({ changed, label, hostPort, fp, old }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const r = await dialog.showMessageBox(win, changed ? {
      type: 'warning',
      title: 'Server key changed',
      message: `WARNING: the identity of "${label}" has CHANGED`,
      detail: `Server: ${hostPort}\nSaved:  ${old}\nNow:    ${fp}\n\nThis normally means the server was reinstalled, but it can also mean someone is intercepting your connection. Do not continue unless you know why it changed.`,
      buttons: ['Cancel (recommended)', 'Replace saved key and connect'],
      defaultId: 0, cancelId: 0, noLink: true,
    } : {
      type: 'question',
      title: 'New server',
      message: `First connection to "${label}"`,
      detail: `Server: ${hostPort}\nFingerprint: ${fp}\n\nOnly continue if this is your server. You can compare it on the server with:\nssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`,
      buttons: ['Cancel', 'Trust and connect'],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    return r.response === 1;
  },
});

// Builds the ssh2 connect config for a saved host (shared by terminals and SFTP)
function hostConfig(hostId) {
  if (!session) return { error: 'Vault locked' };
  const h = session.data.hosts.find((x) => x.id === hostId);
  if (!h) return { error: 'Host not found' };
  const cfg = {
    host: h.host,
    port: Number(h.port) || 22,
    username: h.username,
    readyTimeout: 120000, // includes the time you take to answer a new-server prompt
    keepaliveInterval: 15000,
    hostHash: 'sha256',
  };
  // keep the braces: ssh2 must not see a return value here, or it stops waiting for verify() and skips the check
  cfg.hostVerifier = (hex, verify) => { checkHostKey(`${cfg.host}:${cfg.port}`, h.name || h.host, hex).then(verify, () => verify(false)); };
  if (h.authType === 'key') {
    const k = session.data.keys.find((x) => x.id === h.keyId);
    if (!k) return { error: 'Key not found in vault' };
    cfg.privateKey = k.privateKey;
    if (k.passphrase) cfg.passphrase = k.passphrase;
  } else {
    cfg.password = h.password;
  }
  return { cfg };
}
require('./sftp-main').register(ipcMain, hostConfig, (id) => session?.data.s3?.find((x) => x.id === id));
const tunnels = require('./tunnels-main').register(ipcMain, hostConfig, (id) => session?.data.forwards?.find((f) => f.id === id));

ipcMain.handle('ssh:connect', (e, id, hostId, extra = {}) => {
  return new Promise((resolve) => {
    const hc = hostConfig(hostId);
    if (hc.error) return resolve({ error: hc.error });
    const cfg = hc.cfg;

    const c = new Client();
    const send = (ch, ...a) => { if (!e.sender.isDestroyed()) e.sender.send(ch, id, ...a); };
    let timer = null, closed = false;
    // clean = the shell ended with an exit code (user typed exit); a dropped connection or a killed shell (reboot) is not clean
    const gone = (clean) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      conns.delete(id);
      send('ssh:close', { clean });
    };
    c.on('ready', () => {
      c.shell({ term: 'xterm-256color', cols: extra.cols || 80, rows: extra.rows || 24 }, (err, stream) => {
        if (err) { c.end(); return resolve({ error: err.message }); }
        timer = startStats(c, send);
        conns.set(id, { c, stream, timer });
        stream.on('data', (d) => send('ssh:data', d.toString('utf8')));
        stream.on('close', (code) => { gone(typeof code === 'number'); c.end(); });
        resolve({ ok: true });
      });
    });
    c.on('error', (err) => { resolve({ error: friendly(err.message) }); gone(false); });
    c.on('close', () => gone(false));
    c.connect(cfg);
  });
});
ipcMain.on('ssh:write', (_, id, d) => conns.get(id)?.stream.write(d));
ipcMain.on('ssh:resize', (_, id, cols, rows) => conns.get(id)?.stream.setWindow(rows, cols, 0, 0));
ipcMain.on('ssh:disconnect', (_, id) => {
  const x = conns.get(id);
  if (x) { clearInterval(x.timer); x.c.end(); conns.delete(id); }
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.sshvault.app'); // lets Windows pin it to the taskbar with its own identity
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#14161a',
    title: 'SSHVault',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('renderer/index.html');
});
app.on('window-all-closed', () => app.quit());
