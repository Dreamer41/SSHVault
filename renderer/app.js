const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => e.append(k));
  return e;
};
const uid = () => Math.random().toString(36).slice(2, 10);

let data = null;
let tab = 'hosts';
const sessions = new Map(); // id -> { term, fit, div, tabEl, name }
let active = null;

const save = () => api.vault.save(data);

// ---------- modal helper ----------
function modal(title, fields, okLabel = 'Save') {
  return new Promise((resolve) => {
    const m = $('#modal');
    const inputs = {};
    const card = el('div', { className: 'card' }, el('h3', { textContent: title }));
    for (const f of fields) {
      let inp;
      if (f.type === 'select') {
        inp = el('select', {}, f.options.map((o) => el('option', { value: o.value, textContent: o.label, selected: o.value === f.value })));
      } else if (f.type === 'textarea') {
        inp = el('textarea', { value: f.value || '', readOnly: !!f.readOnly });
      } else {
        inp = el('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '' });
      }
      inputs[f.name] = inp;
      card.append(el('label', { textContent: f.label }, inp));
    }
    const close = (v) => { m.hidden = true; m.replaceChildren(); resolve(v); };
    const ok = el('button', { className: 'btn primary', textContent: okLabel, onclick: () => {
      const out = {};
      for (const k in inputs) out[k] = inputs[k].value;
      close(out);
    } });
    card.append(el('div', { className: 'row' }, el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }), ok));
    m.replaceChildren(card);
    m.hidden = false;
    card.querySelector('input,textarea')?.focus();
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') ok.click(); if (e.key === 'Escape') close(null); });
  });
}

// ---------- lock screen ----------
async function showLock() {
  const exists = await api.vault.exists();
  const box = $('#lock');
  box.hidden = false;
  $('#app').hidden = true;
  const err = el('div', { className: 'err' });
  const pw = el('input', { type: 'password', placeholder: 'Master password' });
  const pw2 = el('input', { type: 'password', placeholder: 'Repeat master password' });
  const go = async () => {
    err.textContent = '';
    if (exists) {
      const d = await api.vault.unlock(pw.value);
      if (!d) { err.textContent = 'Wrong password'; return; }
      data = d;
    } else {
      if (pw.value.length < 8) { err.textContent = 'Use at least 8 characters'; return; }
      if (pw.value !== pw2.value) { err.textContent = 'Passwords do not match'; return; }
      data = await api.vault.create(pw.value);
    }
    ensureData();
    box.hidden = true;
    $('#app').hidden = false;
    render();
    autostartTunnels();
  };
  box.replaceChildren(el('div', { className: 'card' },
    el('h3', { textContent: exists ? 'Unlock vault' : 'Create vault' }),
    exists ? '' : el('div', { textContent: 'Choose a master password. It encrypts all hosts, keys and snippets. It cannot be recovered.', style: 'color:#99a;font-size:12px' }),
    pw, exists ? '' : pw2, err,
    el('div', { className: 'row' }, el('button', { className: 'btn primary', textContent: exists ? 'Unlock' : 'Create', onclick: go })),
  ));
  box.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  pw.focus();
}

$('#sftpBtn').onclick = () => openSftp();

// ---------- export / import ----------
function backupDialog() {
  return new Promise((resolve) => {
    const m = $('#modal');
    const close = (v) => { m.hidden = true; m.replaceChildren(); resolve(v); };
    m.replaceChildren(el('div', { className: 'card' },
      el('h3', { textContent: 'Move to another computer' }),
      el('div', { style: 'color:#99a;font-size:12px;line-height:1.6', textContent: 'A backup holds all hosts, SSH keys, S3 connections, snippets, commands and settings in ONE file, encrypted with a password you choose here. On the new computer: install SSHVault, create a vault, then import the file.' }),
      el('button', { className: 'btn primary', textContent: 'Export backup file…', onclick: () => close('export') }),
      el('button', { className: 'btn', textContent: 'Import backup file…', onclick: () => close('import') }),
      el('div', { className: 'row' }, el('button', { className: 'btn', textContent: 'Close', onclick: () => close(null) }))));
    m.hidden = false;
  });
}

$('#backupBtn').onclick = async () => {
  const a = await backupDialog();
  if (a === 'export') {
    const r = await modal('Export backup', [
      { name: 'pw', label: 'Backup password (needed to import it; not your master password unless you want it to be)', type: 'password' },
      { name: 'pw2', label: 'Repeat backup password', type: 'password' },
    ], 'Choose file…');
    if (!r) return;
    if (r.pw.length < 8) return alert('Use at least 8 characters for the backup password.');
    if (r.pw !== r.pw2) return alert('Passwords do not match.');
    const res = await api.vault.export(r.pw);
    if (res.error) alert(res.error);
    else if (res.ok) alert('Backup saved to:\n' + res.path + '\n\nIt contains your private keys (encrypted). Keep it safe.');
  } else if (a === 'import') {
    const r = await modal('Import backup', [
      { name: 'pw', label: 'Backup password', type: 'password' },
      { name: 'mode', label: 'How to import', type: 'select', value: 'merge', options: [{ value: 'merge', label: 'Merge: add what is missing, keep what I have' }, { value: 'replace', label: 'Replace everything with the backup' }] },
    ], 'Choose file…');
    if (!r) return;
    if (r.mode === 'replace' && !confirm('Replace ALL current hosts, keys, snippets and settings with the backup?')) return;
    const res = await api.vault.import(r.pw, r.mode);
    if (res.error) return alert(res.error);
    if (res.canceled) return;
    data = res.data;
    ensureData();
    render();
    alert(r.mode === 'replace' ? 'Backup restored.' : 'Imported: ' + Object.entries(res.added).map(([k, n]) => n + ' ' + k).join(', ') + '.');
  }
};

$('#lockBtn').onclick = async () => {
  for (const id of [...sessions.keys()]) closeSession(id);
  await api.vault.lock();
  data = null;
  for (const k of Object.keys(tunnelState)) delete tunnelState[k];
  showLock();
};

document.querySelectorAll('nav [data-tab]').forEach((b) => {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('nav [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    render();
  };
});

// ---------- sidebar panels ----------
function render() {
  const p = $('#panel');
  p.replaceChildren();
  p.className = tab === 'tunnels' ? 'tunnels' : '';
  if (tab === 'tunnels') renderTunnels(p);
  else if (tab === 'hosts') { renderHosts(p); renderS3(p); }
  else if (tab === 'keys') renderKeys(p);
  else renderSnippets(p);
}

function item(title, sub, acts, onclick, ondbl) {
  const row = el('div', { className: 'item', onclick, ondblclick: ondbl },
    el('div', { className: 'txt' }, el('div', { textContent: title }), el('small', { textContent: sub })),
    el('div', { className: 'acts' }, acts));
  return row;
}
const btn = (t, f, cls = '') => el('button', { textContent: t, className: cls, title: t, onclick: (e) => { e.stopPropagation(); f(); } });

// ---- hosts ----
async function editHost(h) {
  const isNew = !h;
  h = h || { id: uid(), port: 22, authType: 'password' };
  const keyOpts = [{ value: '', label: '(none)' }, ...data.keys.map((k) => ({ value: k.id, label: k.name }))];
  const r = await modal(isNew ? 'New host' : 'Edit host', [
    { name: 'name', label: 'Label', value: h.name },
    { name: 'host', label: 'Hostname / IP', value: h.host },
    { name: 'port', label: 'Port', value: h.port },
    { name: 'username', label: 'Username', value: h.username },
    { name: 'group', label: 'Group (optional)', value: h.group },
    { name: 'sftpPath', label: 'SFTP start folder (optional)', value: h.sftpPath, placeholder: '/sharedfolders/Photos' },
    { name: 'authType', label: 'Authentication', type: 'select', value: h.authType, options: [{ value: 'password', label: 'Password' }, { value: 'key', label: 'SSH key from vault' }] },
    { name: 'password', label: 'Password (if password auth)', type: 'password', value: h.password },
    { name: 'keyId', label: 'Key (if key auth)', type: 'select', value: h.keyId || '', options: keyOpts },
  ]);
  if (!r) return;
  Object.assign(h, r);
  if (!h.name) h.name = h.host;
  if (isNew) data.hosts.push(h);
  await save();
  render();
}

function renderHosts(p) {
  p.append(el('button', { className: 'btn primary', textContent: '+ New host', onclick: () => editHost() }));
  if (!data.hosts.length) p.append(el('div', { textContent: 'No hosts yet.', style: 'color:#667;padding:12px' }));
  const groups = [...new Set(data.hosts.map((h) => h.group || 'Ungrouped'))].sort();
  for (const g of groups) {
    p.append(el('h4', { textContent: g }));
    for (const h of data.hosts.filter((x) => (x.group || 'Ungrouped') === g)) {
      p.append(item(h.name, `${h.username}@${h.host}:${h.port}`, [
        btn('SFTP', () => openSftp(h.id)),
        btn('Edit', () => editHost(h)),
        btn('Del', async () => { if (confirm(`Delete ${h.name}?`)) { data.hosts = data.hosts.filter((x) => x !== h); await save(); render(); } }, 'danger'),
      ], null, () => connect(h)));
    }
  }
}

// ---- S3 buckets ----
async function editS3(b) {
  const isNew = !b;
  b = b || { id: uid(), region: 'us-east-1', storageClass: 'STANDARD' };
  const r = await modal(isNew ? 'New S3 bucket' : 'Edit S3 bucket', [
    { name: 'name', label: 'Label', value: b.name },
    { name: 'bucket', label: 'Bucket name', value: b.bucket },
    { name: 'accessKeyId', label: 'Access key ID', value: b.accessKeyId },
    { name: 'secretAccessKey', label: 'Secret access key', type: 'password', value: b.secretAccessKey },
    { name: 'region', label: 'Region', value: b.region, placeholder: 'us-east-1' },
    { name: 'prefix', label: 'Start in folder (optional)', value: b.prefix, placeholder: 'backup/' },
    { name: 'storageClass', label: 'Storage class for uploads from here', type: 'select', value: b.storageClass, options: ['STANDARD', ...S3_CLASSES.filter((c) => c !== 'STANDARD')].map((c) => ({ value: c, label: c })) },
    { name: 'endpoint', label: 'Custom endpoint (only for non-AWS, e.g. MinIO / Backblaze)', value: b.endpoint, placeholder: 'leave empty for AWS' },
  ]);
  if (!r) return;
  Object.assign(b, r, { accessKeyId: r.accessKeyId.trim(), secretAccessKey: r.secretAccessKey.trim(), bucket: r.bucket.trim(), endpoint: r.endpoint.trim() });
  if (!b.name) b.name = b.bucket;
  if (isNew) data.s3.push(b);
  await save();
  render();
}

function renderS3(p) {
  p.append(el('h4', { textContent: 'S3 buckets' }), el('button', { className: 'btn', textContent: '+ New S3 bucket', onclick: () => editS3() }));
  for (const b of data.s3) {
    p.append(item(b.name, 's3://' + b.bucket + (b.prefix ? '/' + b.prefix.replace(/^\/+/, '') : ''), [
      btn('Browse', () => openSftp('s3:' + b.id)),
      btn('Edit', () => editS3(b)),
      btn('Del', async () => { if (confirm('Delete S3 connection ' + b.name + '?')) { data.s3 = data.s3.filter((x) => x !== b); await save(); render(); } }, 'danger'),
    ], null, () => openSftp('s3:' + b.id)));
  }
}

// ---- keys ----
async function renderKeys(p) {
  p.append(el('div', { className: 'row', style: 'justify-content:flex-start' },
    el('button', { className: 'btn primary', textContent: 'Generate ed25519', onclick: async () => {
      const r = await modal('Generate key', [{ name: 'name', label: 'Key name', value: 'my-key' }], 'Generate');
      if (!r) return;
      const k = await api.generateKey(r.name);
      data.keys.push({ id: uid(), name: r.name, ...k });
      await save();
      render();
    } }),
    el('button', { className: 'btn', textContent: 'Import file…', onclick: async () => {
      const files = await api.pickKeyFiles();
      const failed = [];
      for (const f of files) {
        if (f.error) { failed.push(`${f.name}: ${f.error}`); continue; }
        let passphrase = '';
        let res = await api.parseKey(f.privateKey, passphrase);
        while (res.needsPassphrase) {
          const r = await modal(`Passphrase for ${f.name}`, [{ name: 'pw', label: 'Key passphrase', type: 'password' }], 'Unlock');
          if (!r) break;
          passphrase = r.pw;
          res = await api.parseKey(f.privateKey, passphrase);
        }
        if (res.error) { failed.push(`${f.name}: ${res.error}`); continue; }
        // A converted PuTTY key comes back already decrypted, so no passphrase is stored for it
        data.keys.push({ id: uid(), name: f.name, privateKey: res.privateKey || f.privateKey, passphrase: res.privateKey ? '' : passphrase, publicKey: res.publicKey });
      }
      await save();
      render();
      if (failed.length) alert('Could not import:\n' + failed.join('\n'));
    } }),
    el('button', { className: 'btn', textContent: 'Paste', onclick: async () => {
      const r = await modal('Import private key', [
        { name: 'name', label: 'Key name' },
        { name: 'privateKey', label: 'Private key (paste OpenSSH/PEM)', type: 'textarea' },
        { name: 'passphrase', label: 'Passphrase (if any)', type: 'password' },
      ], 'Import');
      if (!r || !r.privateKey.trim()) return;
      data.keys.push({ id: uid(), name: r.name || 'imported', privateKey: r.privateKey.trim() + '\n', passphrase: r.passphrase, publicKey: '' });
      await save();
      render();
    } })));
  if (!data.keys.length) p.append(el('div', { textContent: 'Vault has no keys.', style: 'color:#667;padding:12px' }));
  for (const k of data.keys) {
    p.append(item(k.name, k.publicKey ? k.publicKey.trim().slice(0, 60) : '(imported, no public key)', [
      k.publicKey ? btn('Pub', async () => { await api.copy(k.publicKey.trim()); alert('Public key copied to clipboard'); }) : '',
      btn('Del', async () => {
        if (!confirm(`Delete key ${k.name}? This cannot be undone.`)) return;
        data.keys = data.keys.filter((x) => x !== k);
        await save();
        render();
      }, 'danger'),
    ]));
  }
  p.append(el('div', { textContent: 'Install a public key on a server: paste it into ~/.ssh/authorized_keys.', style: 'color:#667;font-size:12px;padding:12px' }));
}

// ---- snippets ----
function allSnippets() { return [...DEFAULT_SNIPPETS, ...data.snippets]; }
let snipFilter = '';

function renderSnippets(p) {
  const search = el('input', { placeholder: 'Search snippets…', value: snipFilter, style: 'width:100%;margin-bottom:6px', oninput: () => { snipFilter = search.value; renderList(); } });
  const list = el('div');
  p.append(search, el('button', { className: 'btn primary', textContent: '+ New snippet', onclick: async () => {
    const r = await modal('New snippet', [
      { name: 'name', label: 'Name' },
      { name: 'group', label: 'Group', value: 'Custom' },
      { name: 'command', label: 'Command (use {{var}} for prompts)', type: 'textarea' },
    ]);
    if (!r || !r.command) return;
    data.snippets.push({ id: uid(), ...r });
    await save();
    render();
  } }), list);
  function renderList() {
    list.replaceChildren();
    const q = snipFilter.toLowerCase();
    const items = allSnippets().filter((s) => !q || (s.name + s.command + s.group).toLowerCase().includes(q));
    const row = (s) => item(s.name, s.command, s.builtin ? [] : [
      btn('Del', async () => { data.snippets = data.snippets.filter((x) => x !== s); await save(); render(); }, 'danger'),
    ], () => runSnippet(s));
    const recent = (data.recent || []).map((id) => items.find((s) => s.id === id)).filter(Boolean);
    if (recent.length) {
      list.append(el('h4', { textContent: 'Recently used' }));
      recent.forEach((s) => list.append(row(s)));
    }
    for (const g of [...new Set(items.map((s) => s.group))]) {
      list.append(el('h4', { textContent: g }));
      for (const s of items.filter((x) => x.group === g)) list.append(row(s));
    }
  }
  renderList();
  if (!snipFilter) search.focus();
}

async function runSnippet(s) {
  if (!active || sessions.get(active)?.isSftp) { alert('Open a terminal first (double-click a host).'); return; }
  let cmd = s.command;
  const vars = [...new Set([...cmd.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
  if (vars.length) {
    const r = await modal(s.name, vars.map((v) => ({ name: v, label: v })), 'Insert');
    if (!r) return;
    for (const v of vars) cmd = cmd.replaceAll(`{{${v}}}`, r[v]);
  }
  // Sent without Enter so you can review it; hold nothing back for harmless ones
  api.ssh.write(active, cmd);
  sessions.get(active)?.term.focus();

  // Most recently used first, no duplicates, keep the last 10
  data.recent = [s.id, ...(data.recent || []).filter((id) => id !== s.id)].slice(0, 10);
  await save();
  if (tab === 'snippets') { render(); sessions.get(active)?.term.focus(); } // render() focuses the search box
}

// ---------- terminals ----------
async function connect(h, opts = {}) {
  const id = uid();
  const div = el('div', { className: 'term' });
  $('#terms').append(div);
  $('#empty').hidden = true;
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 14, cursorBlink: true, theme: { background: '#14161a' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(div);

  const tabEl = el('div', { className: 'tab', onclick: () => activate(id) }, h.name,
    el('span', { textContent: '✕', onclick: (e) => { e.stopPropagation(); closeSession(id); } }));
  $('#tabs').append(tabEl);
  const s = { term, fit, div, tabEl, h, stats: null, cpuHist: [], connected: false, dead: false, reconnecting: false, closing: false };
  s.banner = el('div', { className: 'reconnect-bar', hidden: true },
    el('span', { textContent: 'Connection lost' }),
    el('button', { className: 'btn primary', textContent: 'Reconnect', onclick: () => manualReconnect(id) }));
  div.append(s.banner);
  sessions.set(id, s);
  div.addEventListener('mousedown', () => { if (active !== id) activate(id); }, true);
  if (opts.splitFrom && sessions.has(opts.splitFrom)) split = { a: opts.splitFrom, b: id, dir: opts.dir || 'h' };
  activate(id);

  term.write(`Connecting to ${h.username}@${h.host}…\r\n`);
  // while the connection is down, Enter reconnects and everything else is ignored
  term.onData((d) => { if (s.dead) { if (d === '\r') manualReconnect(id); return; } if (!s.reconnecting) api.ssh.write(id, d); });

  const doPaste = async () => { const t = await api.paste(); if (t) term.paste(t); };
  const doCopy = async () => { await api.copy(term.getSelection()); term.clearSelection(); };
  // Ctrl+C copies when text is selected (otherwise it stays Ctrl+C / SIGINT); Ctrl+V and Ctrl+Shift+C/V also work
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && (e.shiftKey || term.hasSelection())) { if (term.hasSelection()) doCopy(); return false; }
    if (k === 'v') { e.preventDefault(); doPaste(); return false; } // preventDefault stops the browser's own paste event, which caused a double paste
    return true;
  });
  // Right-click / two-finger tap always pastes (selected text is already copied on select)
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    term.clearSelection();
    doPaste();
  });
  term.onSelectionChange(() => { if (term.hasSelection()) api.copy(term.getSelection()); });
  term.onResize(({ cols, rows }) => api.ssh.resize(id, cols, rows));
  const res = await api.ssh.connect(id, h.id, { cols: term.cols, rows: term.rows });
  if (res.error) { term.write(`\r\n\x1b[31mError: ${res.error}\x1b[0m\r\n`); markDead(id, 'Could not connect'); }
  else s.connected = true;
}

// ---------- reconnect after a reboot / dropped connection ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS = [5, 10, 15, 20, 30]; // seconds before each of the 5 automatic attempts

function setTabState(s, prefix) { s.tabEl.firstChild.textContent = prefix + s.h.name; }

function markDead(id, text) {
  const s = sessions.get(id);
  if (!s) return;
  s.dead = true;
  s.reconnecting = false;
  s.connected = false;
  s.stats = null;
  setTabState(s, '⚠ ');
  s.banner.firstChild.textContent = text;
  s.banner.hidden = false;
  if (active === id) renderStatus();
}

async function tryConnect(id) {
  const s = sessions.get(id);
  const res = await api.ssh.connect(id, s.h.id, { cols: s.term.cols, rows: s.term.rows });
  if (res.error) return res;
  s.connected = true;
  s.dead = false;
  s.reconnecting = false;
  s.banner.hidden = true;
  setTabState(s, '');
  s.term.write('\r\x1b[2K\x1b[32m[reconnected]\x1b[0m\r\n');
  return res;
}

async function autoReconnect(id) {
  const s = sessions.get(id);
  s.reconnecting = true;
  setTabState(s, '⟳ ');
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    for (let t = RETRY_DELAYS[i]; t > 0; t--) {
      if (!sessions.has(id) || s.closing) return;
      s.term.write(`\r\x1b[2K\x1b[33mReconnecting (${i + 1}/${RETRY_DELAYS.length}) in ${t}s…\x1b[0m`);
      await sleep(1000);
    }
    if (!sessions.has(id) || s.closing) return;
    s.term.write(`\r\x1b[2K\x1b[33mReconnecting (${i + 1}/${RETRY_DELAYS.length}) now…\x1b[0m`);
    const res = await tryConnect(id);
    if (!res.error) return;
    // a refused login will not fix itself, and repeated bad logins can get this PC banned by the server
    if (/authentication|permission denied/i.test(res.error)) {
      s.term.write(`\r\n\x1b[31m${res.error}\x1b[0m\r\n`);
      return markDead(id, 'Login refused');
    }
  }
  s.term.write('\r\n\x1b[31mServer is still not reachable.\x1b[0m Press Enter or the Reconnect button to try again.\r\n');
  markDead(id, 'Server not reachable');
}

async function manualReconnect(id) {
  const s = sessions.get(id);
  if (!s || s.reconnecting || !s.dead) return;
  s.reconnecting = true;
  s.banner.hidden = true;
  setTabState(s, '⟳ ');
  s.term.write('\r\n\x1b[33mReconnecting…\x1b[0m');
  const res = await tryConnect(id);
  if (res.error) {
    s.term.write(`\r\n\x1b[31m${res.error}\x1b[0m\r\n`);
    markDead(id, 'Could not connect');
  }
}

// ---------- split view ----------
// split = { a, b, dir } holds two terminal session ids shown side by side ('h') or stacked ('v'); SFTP tabs are never part of it.
let split = null;
let lastFocus = null; // the terminal of the split that has focus; clicking another tab replaces the OTHER one

function layout() {
  const shown = new Set(split && active && !sessions.get(active)?.isSftp ? [split.a, split.b] : active ? [active] : []);
  for (const [k, s] of sessions) {
    const on = shown.has(k);
    const two = on && shown.size === 2;
    const [p1, p2] = split?.dir === 'v' ? ['t', 'b'] : ['l', 'r'];
    s.div.classList.toggle('on', on);
    s.div.classList.toggle('split', two);
    s.div.classList.toggle('focus', two && k === active);
    s.div.classList.toggle(p1, two && k === split.a);
    s.div.classList.toggle(p2, two && k === split.b);
    for (const x of ['l', 'r', 't', 'b']) if (x !== p1 && x !== p2) s.div.classList.remove(x);
    s.tabEl.classList.toggle('on', k === active);
    s.tabEl.classList.toggle('also', two && k !== active);
  }
  requestAnimationFrame(() => {
    for (const k of shown) sessions.get(k)?.fit.fit();
    sessions.get(active)?.term.focus();
  });
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (split && !s.isSftp && id !== split.a && id !== split.b) {
    // a tab outside the split was clicked: it takes the place of the pane that does not have focus
    if (split.a === lastFocus) split.b = id; else split.a = id;
  }
  active = id;
  if (split && (id === split.a || id === split.b)) lastFocus = id;
  layout();
  renderStatus();
}

function unsplit() { split = null; layout(); }

$('#splitBtn').onclick = (e) => {
  e.stopPropagation();
  const cur = active && sessions.get(active);
  const terms = [...sessions].filter(([, s]) => !s.isSftp);
  if (!cur || cur.isSftp) return alert('Select a terminal tab first.');
  const items = [];
  items.push([`Right: new session on ${cur.h.name}`, () => connect(cur.h, { splitFrom: active, dir: 'h' })]);
  items.push([`Below: new session on ${cur.h.name}`, () => connect(cur.h, { splitFrom: active, dir: 'v' })]);
  for (const [k, s] of terms) {
    if (k === active) continue;
    items.push([`Right: show "${s.h.name}" beside this`, () => { split = { a: active, b: k, dir: 'h' }; lastFocus = active; layout(); }]);
    items.push([`Below: show "${s.h.name}" under this`, () => { split = { a: active, b: k, dir: 'v' }; lastFocus = active; layout(); }]);
  }
  if (split) items.push(['Unsplit', unsplit]);
  const menu = el('div', { className: 'ctxmenu', id: 'splitMenu' }, items.map(([t, f]) => el('div', { className: 'mi', textContent: t, onclick: () => { menu.remove(); f(); } })));
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.top = r.bottom + 2 + 'px';
  document.body.append(menu);
  const away = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', away, true); } };
  setTimeout(() => document.addEventListener('mousedown', away, true));
};

// ---------- status bar (live server stats) ----------
const fmtBytes = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : `${Math.round(b / 2 ** 20)} MB`);
const fmtMbit = (bps) => `${((bps * 8) / 1e6).toFixed(2)} Mb/s`;
const fmtUptime = (s) => (s >= 172800 ? `${Math.floor(s / 86400)} days` : s >= 7200 ? `${Math.floor(s / 3600)} hours` : `${Math.floor(s / 60)} min`);

function renderStatus() {
  const bar = $('#status');
  bar.replaceChildren();
  const s = active && sessions.get(active)?.stats;
  if (!s) return;
  const stat = (icon, text, warn) => el('div', { className: 'stat' + (warn ? ' warn' : '') }, icon ? el('span', { textContent: icon }) : '', text);
  const canvas = el('canvas', { width: 70, height: 20 });
  const g = canvas.getContext('2d');
  g.strokeStyle = '#4cd37b';
  g.beginPath();
  sessions.get(active).cpuHist.forEach((v, i, a) => {
    const x = (i / 39) * 70 + (40 - a.length) * (70 / 39);
    const y = 19 - (v / 100) * 18;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
  bar.append(
    stat('🖥', s.host),
    stat('', `${Math.round(s.cpu)}%`, s.cpu > 90), canvas,
    stat('🧠', `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`, s.memUsed / s.memTotal > 0.9),
    stat('⬆', fmtMbit(s.up)),
    stat('⬇', fmtMbit(s.down)),
    stat('⏱', fmtUptime(s.uptime)),
    stat('👤', [s.me, ...s.users.filter((u) => u !== s.me)].join('  ')),
    ...s.disks.slice(0, 4).map((d) => stat('', `${d.mount}: ${d.pct}%`, d.pct >= 90)),
  );
}

api.ssh.onStats((id, s) => {
  const sess = sessions.get(id);
  if (!sess) return;
  sess.stats = s;
  sess.cpuHist = [...sess.cpuHist, s.cpu].slice(-40);
  if (id === active) renderStatus();
});

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.closing = true;
  api.ssh.disconnect(id);
  s.onClose?.();
  s.term.dispose();
  s.div.remove();
  s.tabEl.remove();
  sessions.delete(id);
  let partner = null;
  if (split && (split.a === id || split.b === id)) { partner = split.a === id ? split.b : split.a; split = null; }
  if (active === id) {
    active = null;
    const next = partner || [...sessions.keys()].pop();
    if (next) activate(next);
  }
  layout();
  $('#empty').hidden = sessions.size > 0;
  renderStatus();
}

api.ssh.onData((id, d) => sessions.get(id)?.term.write(d));
api.ssh.onClose((id, info) => {
  const s = sessions.get(id);
  if (!s || s.closing || s.reconnecting || s.dead) return; // closes caused by our own reconnect attempts are handled there
  s.term.write('\r\n\x1b[33m[connection closed]\x1b[0m\r\n');
  if (!s.connected) return markDead(id, 'Could not connect');
  s.connected = false;
  s.stats = null;
  if (active === id) renderStatus();
  if (info?.clean) markDead(id, 'Session ended'); // you typed exit: do not fight it, just offer a button
  else autoReconnect(id);
});
window.addEventListener('resize', () => { if (active) layout(); });

showLock();
