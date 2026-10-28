// SFTP file browser: two panes (this PC or any saved host). Drag files between panes to copy them.
// Uses helpers from app.js (el, uid, data, sessions, activate, closeSession, modal).

const fmtSize = (n) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '');

let sftpTab = null; // { panes: [left, right] }
let dragPayload = null; // { pane, paths } while an internal drag is in flight
const xferJobs = new Map(); // jobId -> { row, bar, label, dst, dstSrc }

function createPane(defaultSource) {
  const pane = { kind: 'local', src: null, hostValue: null, path: '', sep: '/', parent: null, entries: [], sel: new Set(), anchor: null, sort: { key: 'name', asc: true } };
  const join = (dir, name) => (dir === '' ? name : dir.endsWith(pane.sep) ? dir + name : dir + pane.sep + name);
  pane.join = join;

  const select = el('select', { onchange: () => pane.setSource(select.value) });
  const pathInput = el('input', { className: 'pathbox', onkeydown: (e) => { if (e.key === 'Enter') { pane.go(pathInput.value); e.stopPropagation(); } } });
  const msg = el('div', { className: 'pane-msg' });
  const list = el('div', { className: 'flist' });
  const tb = (txt, title, fn) => el('button', { className: 'btn', textContent: txt, title, onclick: fn });
  const other = () => sftpTab.panes.find((p) => p !== pane);

  const selectedPaths = () => [...pane.sel].map((n) => join(pane.path, n));
  const refresh = () => pane.go(pane.path);
  const need = () => (pane.src ? true : false);

  const cmdBtn = tb('Commands ▾', 'Custom commands and "compress → S3"', (e) => showCmdMenu(pane, e.currentTarget));
  const restoreBtn = tb('❄ Restore', 'Ask S3 to restore archived (Glacier / Deep Archive) objects', () => pane.restore());
  const head = el('div', { className: 'pane-head' },
    el('div', { className: 'row', style: 'justify-content:flex-start' }, select, pathInput),
    el('div', { className: 'row', style: 'justify-content:flex-start;flex-wrap:wrap' },
      tb('⬆', 'Parent folder', () => pane.parent !== null && pane.go(pane.parent)),
      tb('⟳', 'Refresh (F5)', refresh),
      tb('📌', 'Always start in this folder when opening this server', async () => {
        if (!need() || pane.kind === 'local') return setMsg('Pick a server or S3 bucket first');
        if (pane.kind === 'ssh') data.hosts.find((h) => h.id === pane.hostValue).sftpPath = pane.path;
        else data.s3.find((b) => 's3:' + b.id === pane.hostValue).prefix = pane.path.replace(/^\/+/, '');
        await save();
        setMsg(`Saved: this server will open in ${pane.path}`);
      }),
      tb('＋📁', 'New folder', async () => {
        if (!need()) return;
        const r = await modal('New folder', [{ name: 'n', label: 'Name' }], 'Create');
        if (!r || !r.n) return;
        const res = await api.sftp.mkdir(pane.src, pane.path, r.n);
        res.error ? setMsg(res.error) : refresh();
      }),
      tb('✎', 'Rename (F2)', () => pane.rename()),
      tb('🗑', 'Delete (Del)', () => pane.remove()),
      tb('Copy ➜ other pane', 'Copy the selection to the other pane', () => {
        if (!pane.sel.size) return setMsg('Select something first');
        startTransfer(pane, selectedPaths(), other(), other().path);
      }),
      cmdBtn, restoreBtn,
    ));

  function setMsg(t) { msg.textContent = t; msg.hidden = !t; }
  pane.setMsg = setMsg;

  pane.rename = async () => {
    if (!need() || pane.sel.size !== 1) return setMsg('Select exactly one item to rename');
    const old = [...pane.sel][0];
    const r = await modal('Rename', [{ name: 'n', label: 'New name', value: old }], 'Rename');
    if (!r || !r.n || r.n === old) return;
    const res = await api.sftp.rename(pane.src, pane.path, old, r.n);
    res.error ? setMsg(res.error) : refresh();
  };
  pane.remove = async () => {
    if (!need() || !pane.sel.size) return;
    if (!confirm(`Delete ${pane.sel.size} item(s)? This cannot be undone.`)) return;
    const res = await api.sftp.remove(pane.src, pane.path, [...pane.sel]);
    res.error ? setMsg(res.error) : refresh();
  };

  pane.restore = async () => {
    if (!need() || !pane.sel.size) return setMsg('Select the archived files or folders to restore first');
    const r = await modal('Restore from archive', [
      { name: 'days', label: 'Keep restored copy available for (days)', value: '7' },
      { name: 'tier', label: 'Speed (Deep Archive: Standard ≈ 12h, Bulk ≈ 48h, cheaper)', type: 'select', value: 'Bulk', options: [{ value: 'Bulk', label: 'Bulk (cheapest)' }, { value: 'Standard', label: 'Standard' }] },
    ], 'Request restore');
    if (!r) return;
    setMsg('Requesting restore…');
    const res = await api.sftp.restore(pane.src, selectedPaths(), Math.max(1, parseInt(r.days, 10) || 7), r.tier);
    setMsg(res.error ? res.error : `Restore requested for ${res.requested} object(s); ${res.inProgress} already in progress; ${res.skipped} not archived. Download them once S3 finishes (hours).`);
  };

  pane.setSource = async (value) => {
    if (pane.src && pane.src !== 'local') api.sftp.close(pane.src);
    pane.hostValue = value;
    pane.kind = value === 'local' ? 'local' : value.startsWith('s3:') ? 's3' : 'ssh';
    select.value = value;
    pane.entries = [];
    pane.sel.clear();
    pane.path = '';
    render();
    if (value === 'local') pane.src = 'local';
    else {
      pane.src = null;
      setMsg('Connecting…');
      const id = uid();
      const r = pane.kind === 's3' ? await api.sftp.openS3(id, value.slice(3)) : await api.sftp.open(id, value);
      if (r.error) return setMsg(`Connection failed: ${r.error}`);
      setMsg('');
      pane.src = id;
    }
    // each server can have its own start folder; fall back to the home folder if it is gone
    const sp = pane.kind === 'ssh' ? data.hosts.find((h) => h.id === value)?.sftpPath?.trim() : '';
    await pane.go(sp || null);
    if (sp && pane.path === '') { await pane.go(null); setMsg(`Start folder ${sp} not found, opened the home folder instead`); }
  };

  pane.go = async (dir) => {
    if (!pane.src) return;
    const r = await api.sftp.list(pane.src, dir);
    if (r.error) return setMsg(r.error);
    Object.assign(pane, { path: r.path, sep: r.sep, parent: r.parent, entries: r.entries });
    pane.sel.clear();
    pane.anchor = null;
    setMsg('');
    render();
  };

  function sorted() {
    const { key, asc } = pane.sort;
    const dir = asc ? 1 : -1;
    return [...pane.entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const v = key === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : (a[key] || 0) - (b[key] || 0);
      return v * dir;
    });
  }

  const rows = new Map(); // name -> row element
  const paintSel = () => rows.forEach((row, name) => row.classList.toggle('sel', pane.sel.has(name)));

  function handleDrop(e, dstDir) {
    e.preventDefault();
    if (dragPayload) {
      const d = dragPayload;
      dragPayload = null;
      if (d.pane === pane && dstDir === pane.path) return;
      return startTransfer(d.pane, d.paths, pane, dstDir);
    }
    // files dragged in from Windows Explorer
    const files = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    if (files.length) startTransfer({ src: 'local', sep: '\\' }, files, pane, dstDir);
  }

  function render() {
    cmdBtn.hidden = pane.kind !== 'ssh';
    restoreBtn.hidden = pane.kind !== 's3';
    pathInput.value = pane.src === 'local' && pane.path === '' ? 'This PC' : pane.path;
    list.replaceChildren();
    rows.clear();
    const hdr = el('div', { className: 'frow fhead' });
    for (const [key, label] of [['name', 'Name'], ['size', 'Size'], ['mtime', 'Modified']]) {
      const arrow = pane.sort.key === key ? (pane.sort.asc ? ' ▲' : ' ▼') : '';
      hdr.append(el('div', { textContent: label + arrow, onclick: () => { pane.sort = { key, asc: pane.sort.key === key ? !pane.sort.asc : true }; render(); } }));
    }
    list.append(hdr);
    if (pane.parent !== null && pane.src) {
      list.append(el('div', { className: 'frow', ondblclick: () => pane.go(pane.parent) }, el('div', { textContent: '📁 ..' }), el('div'), el('div')));
    }
    const items = sorted();
    items.forEach((en, idx) => {
      const row = el('div', { className: 'frow', draggable: true },
        el('div', { title: en.name }, `${en.isDir ? '📁' : '📄'} ${en.name}`, en.cls ? el('span', { className: 'cls', textContent: ` ${en.cls}` }) : ''),
        el('div', { textContent: en.isDir ? '' : fmtSize(en.size) }),
        el('div', { textContent: fmtDate(en.mtime) }));
      row.onclick = (e) => {
        if (e.shiftKey && pane.anchor !== null) {
          const [a, b] = [pane.anchor, idx].sort((x, y) => x - y);
          pane.sel = new Set(items.slice(a, b + 1).map((x) => x.name));
        } else if (e.ctrlKey) {
          pane.sel.has(en.name) ? pane.sel.delete(en.name) : pane.sel.add(en.name);
          pane.anchor = idx;
        } else {
          pane.sel = new Set([en.name]);
          pane.anchor = idx;
        }
        paintSel();
      };
      row.ondblclick = () => { if (en.isDir) pane.go(join(pane.path, en.name)); };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        if (!pane.sel.has(en.name)) { pane.sel = new Set([en.name]); pane.anchor = idx; paintSel(); }
        if (pane.kind === 'ssh') showCmdMenu(pane, null, e.clientX, e.clientY);
      };
      row.ondragstart = (e) => {
        if (!pane.sel.has(en.name)) { pane.sel = new Set([en.name]); paintSel(); }
        dragPayload = { pane, paths: selectedPaths() };
        e.dataTransfer.setData('text/plain', 'sshvault-sftp');
        e.dataTransfer.effectAllowed = 'copy';
      };
      row.ondragend = () => { dragPayload = null; };
      if (en.isDir) { // dropping on a folder copies into that folder
        row.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('droptarget'); };
        row.ondragleave = () => row.classList.remove('droptarget');
        row.ondrop = (e) => { e.stopPropagation(); row.classList.remove('droptarget'); list.classList.remove('drop'); handleDrop(e, join(pane.path, en.name)); };
      }
      rows.set(en.name, row);
      list.append(row);
    });
    paintSel();
  }

  list.ondragover = (e) => { e.preventDefault(); list.classList.add('drop'); };
  list.ondragleave = (e) => { if (e.target === list) list.classList.remove('drop'); };
  list.ondrop = (e) => { list.classList.remove('drop'); handleDrop(e, pane.path); };

  pane.root = el('div', { className: 'pane', tabIndex: 0, onkeydown: (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Delete') pane.remove();
    else if (e.key === 'F2') pane.rename();
    else if (e.key === 'F5') refresh();
    else if (e.key === 'Backspace' && pane.parent !== null) pane.go(pane.parent);
    else if (e.key === 'Enter' && pane.sel.size === 1) { const n = [...pane.sel][0]; if (pane.entries.find((x) => x.name === n)?.isDir) pane.go(join(pane.path, n)); }
    else if (e.key.toLowerCase() === 'a' && e.ctrlKey) { e.preventDefault(); pane.sel = new Set(pane.entries.map((x) => x.name)); paintSel(); }
  } }, head, msg, list);
  msg.hidden = true;

  pane.refreshHosts = () => {
    const cur = pane.hostValue || defaultSource;
    select.replaceChildren(el('option', { value: 'local', textContent: '💻 This PC' }),
      ...data.hosts.map((h) => el('option', { value: h.id, textContent: `🖧 ${h.name}` })),
      ...(data.s3 || []).map((b) => el('option', { value: 's3:' + b.id, textContent: `☁ ${b.name}` })));
    select.value = cur;
  };
  pane.refreshHosts();
  return pane;
}

// ---------- transfers ----------
async function startTransfer(srcPane, paths, dstPane, dstDir) {
  if (!dstPane.src || !srcPane.src) return;
  const sep = srcPane.sep;
  if (srcPane.src === dstPane.src && paths.some((p) => dstDir === p || dstDir.startsWith(p.endsWith(sep) ? p : p + sep))) {
    return dstPane.setMsg('Cannot copy a folder into itself');
  }
  const names = paths.map((p) => p.split(sep).pop());
  if (dstDir === dstPane.path && names.some((n) => dstPane.entries.some((e) => e.name === n))
    && !confirm('Some of these already exist in the destination. Overwrite them?')) return;

  const jobId = uid();
  const bar = el('div', { className: 'bar' });
  const label = el('div', { className: 'xlabel', textContent: `Starting… (${names.join(', ')})` });
  const row = el('div', { className: 'xrow' }, label, el('div', { className: 'barwrap' }, bar),
    el('button', { className: 'btn', textContent: '✕', title: 'Cancel', onclick: () => api.sftp.cancel(jobId) }));
  $('#xfers').append(row);
  xferJobs.set(jobId, { row, bar, label, dst: dstPane, dstSrc: dstPane.src });
  const r = await api.sftp.transfer(jobId, srcPane.src, paths, dstPane.src, dstDir);
  if (r.error) finishJob(jobId, { error: r.error });
}

function finishJob(jobId, r) {
  const j = xferJobs.get(jobId);
  if (!j) return;
  xferJobs.delete(jobId);
  if (j.dst.src === j.dstSrc) j.dst.go(j.dst.path);
  if (r.error) {
    j.label.textContent = `Failed: ${r.error}  (click to dismiss)`;
    j.row.classList.add('failed');
    j.row.onclick = () => j.row.remove();
  } else {
    j.bar.style.width = '100%';
    j.label.textContent = 'Done';
    setTimeout(() => j.row.remove(), 2000);
  }
}

api.sftp.onProgress((jobId, p) => {
  const j = xferJobs.get(jobId);
  if (!j) return;
  const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
  j.bar.style.width = `${pct}%`;
  // speed: smoothed over the last few updates so it does not jump around
  const now = Date.now();
  if (j.t) {
    const inst = ((p.done - j.done) * 1000) / Math.max(1, now - j.t);
    j.speed = j.speed ? j.speed * 0.7 + inst * 0.3 : inst;
  }
  j.t = now;
  j.done = p.done;
  const left = j.speed > 0 ? (p.total - p.done) / j.speed : 0;
  const eta = left >= 3600 ? `${Math.floor(left / 3600)}h ${Math.round((left % 3600) / 60)}m` : left >= 60 ? `${Math.round(left / 60)} min` : `${Math.round(left)}s`;
  j.label.textContent = `${p.file || ''} — ${pct.toFixed(0)}%  ${fmtSize(p.done)} / ${fmtSize(p.total)}` + (j.speed > 0 ? `  ${fmtSize(j.speed)}/s  ~${eta} left` : '');
});
api.sftp.onDone((jobId, r) => finishJob(jobId, r));
api.sftp.onClosed((id) => {
  for (const p of sftpTab?.panes || []) if (p.src === id) { p.src = null; p.entries = []; p.setMsg('Connection closed — pick the host again to reconnect'); p.hostValue = null; }
});

// ---------- custom commands (WinSCP-style) ----------
// In a command: ! = selected file name, !/ = current folder, !& = all selected names (quoted), !! = a literal !

const DEFAULT_COMMANDS = [
  { name: 'Upload to S3 (Deep Archive)', command: 'aws s3 cp "!" s3://deeparchivevaris/backup/iphone7/2026/ --storage-class DEEP_ARCHIVE', scope: 'file' },
  { name: 'Extract .tgz (pigz)', command: 'pigz -dc "!" | tar xf -', scope: 'file' },
  { name: 'Compress to .tgz (pigz)', command: 'tar cf - "!" | pigz > "!.tgz"', scope: 'any' },
];
const S3_CLASSES = ['DEEP_ARCHIVE', 'GLACIER', 'GLACIER_IR', 'STANDARD_IA', 'INTELLIGENT_TIERING', 'STANDARD'];

// Called after the vault is unlocked: fills in anything an older vault does not have yet
function ensureData() {
  data.s3 ||= [];
  data.forwards ||= [];
  data.knownHosts ||= {};
  data.archive ||= { dest: 's3://deeparchivevaris/backup/', cls: 'DEEP_ARCHIVE', delTemp: 'yes', delOrig: 'no' };
  if (!data.commands) data.commands = DEFAULT_COMMANDS.map((c) => ({ id: uid(), ...c }));
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // single-quote for a POSIX shell

function expandCmd(tpl, name, dir, names) {
  const esc = (s) => s.replace(/(["\\$`])/g, '\\$1'); // safe inside the "…" users put around !
  return tpl.replace(/!!|!&|!\/|!/g, (m) => (m === '!!' ? '!' : m === '!&' ? names.map((n) => `"${esc(n)}"`).join(' ') : m === '!/' ? esc(dir.endsWith('/') ? dir : dir + '/') : esc(name)));
}

function runCustom(pane, c) {
  const items = [...pane.sel].map((n) => pane.entries.find((e) => e.name === n)).filter(Boolean);
  if (!items.length) return pane.setMsg('Select something first');
  const ok = items.filter((e) => (c.scope === 'file' ? !e.isDir : c.scope === 'dir' ? e.isDir : true));
  if (!ok.length) return pane.setMsg(`"${c.name}" only applies to ${c.scope === 'file' ? 'files' : 'folders'}`);
  const names = ok.map((e) => e.name);
  const lines = c.command.includes('!&') ? [expandCmd(c.command, names[0], pane.path, names)] : names.map((n) => expandCmd(c.command, n, pane.path, names));
  startExec(pane, lines.map((cmd) => ({ show: cmd, run: `cd ${shq(pane.path)} || exit 1\n${cmd}` })), c.name);
}

// Compress on the server, upload to S3, verify the size, then delete the local copy: the deletes only run after a verified upload.
function archiveScript(dir, name, dest, cls, delTemp, delOrig) {
  const m = dest.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  let prefix = m[2];
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return [
    'set -eo pipefail',
    `cd ${shq(dir)}`,
    `f=${shq(name)}`,
    `bucket=${shq(m[1])}`,
    `key=${shq(prefix + name + '.tgz')}`,
    'out="$f.tgz"',
    'if command -v pigz >/dev/null 2>&1; then Z=pigz; else Z=gzip; fi',
    'echo "Compressing $f with $Z ..."',
    'tar cf - -- "$f" | $Z > "$out" || { echo "Compression failed"; rm -f -- "$out"; exit 1; }',
    'lsize=$(stat -c%s "$out")',
    'echo "Uploading $out ($lsize bytes) to s3://$bucket/$key ..."',
    `aws s3 cp "$out" "s3://$bucket/$key" --storage-class ${cls}`,
    'rsize=$(aws s3api head-object --bucket "$bucket" --key "$key" --query ContentLength --output text)',
    'if [ "$lsize" != "$rsize" ]; then echo "SIZE MISMATCH (local $lsize, S3 $rsize) - nothing deleted"; exit 1; fi',
    'echo "Upload verified ($rsize bytes)."',
    delTemp ? 'rm -f -- "$out" && echo "Removed compressed copy $out"' : 'echo "Kept compressed copy $out"',
    delOrig ? 'rm -rf -- "$f" && echo "Removed original $f"' : ':',
    'echo "Done."',
  ].join('\n');
}

async function archiveDialog(pane) {
  const names = [...pane.sel];
  if (!names.length) return pane.setMsg('Select the files or folders to archive first');
  const a = data.archive;
  const yn = (v) => ({ type: 'select', value: v, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] });
  const r = await modal(`Compress → S3 → remove local (${names.length} item${names.length > 1 ? 's' : ''})`, [
    { name: 'dest', label: 'S3 destination (uses the aws CLI already on the server)', value: a.dest, placeholder: 's3://bucket/folder/' },
    { name: 'cls', label: 'Storage class', type: 'select', value: a.cls, options: S3_CLASSES.map((c) => ({ value: c, label: c })) },
    { name: 'par', label: names.length > 1 ? 'How many to process at the same time (each folder always gets its OWN .tgz)' : 'Parallel jobs (only matters with several items)', type: 'select', value: String(a.par || 1), options: [{ value: '1', label: 'One by one (gentlest on the server)' }, { value: '2', label: '2 at the same time' }, { value: '3', label: '3 at the same time' }, { value: '4', label: '4 at the same time' }] },
    { name: 'delTemp', label: 'Delete the compressed .tgz from the server after a verified upload', ...yn(a.delTemp) },
    { name: 'delOrig', label: 'ALSO delete the original file/folder after a verified upload', ...yn(a.delOrig) },
  ], 'Start');
  if (!r) return;
  if (!/^s3:\/\/[^/\s]+(\/\S*)?$/.test(r.dest.trim())) return pane.setMsg('S3 destination must look like s3://bucket/folder/');
  if (r.delOrig === 'yes' && !confirm(`After each verified upload the ORIGINAL will be deleted from the server:\n\n${names.join('\n')}\n\nContinue?`)) return;
  data.archive = { dest: r.dest.trim(), cls: r.cls, delTemp: r.delTemp, delOrig: r.delOrig, par: +r.par };
  await save();
  const jobs = names.map((n) => ({ name: n, script: archiveScript(pane.path, n, r.dest.trim(), r.cls, r.delTemp === 'yes', r.delOrig === 'yes') }));
  const par = Math.min(+r.par || 1, names.length);
  const cmds = par > 1
    ? [{ show: `archive ${names.length} items, ${par} at a time, each into its own .tgz → ${r.dest.trim()}`, run: `bash -c ${shq(parallelScript(jobs, par))}` }]
    : jobs.map((j) => ({ show: `archive ${j.name} → ${r.dest.trim()}`, run: `bash -c ${shq(j.script)}` }));
  startExec(pane, cmds, 'Compress → S3');
}

// Several archives at once: each item still gets its own script and its own .tgz; at most `max` run together.
function parallelScript(jobs, max) {
  const lines = [
    'set +e',
    "trap 'kill $(jobs -p) 2>/dev/null' TERM INT HUP",
    'pids=(); names=()',
    `max=${max}`,
    `lab() { awk -v l="$1" '{ print "[" l "] " $0; fflush() }'; }`,
  ];
  for (const j of jobs) {
    lines.push('while [ "$(jobs -rp | wc -l)" -ge "$max" ]; do sleep 1; done');
    lines.push(`( bash -c ${shq(j.script)} 2>&1 | lab ${shq(j.name)}; exit "\${PIPESTATUS[0]}" ) &`);
    lines.push(`pids+=($!); names+=(${shq(j.name)})`);
  }
  lines.push(
    'bad=0',
    'for i in "${!pids[@]}"; do wait "${pids[$i]}" || { echo "FAILED: ${names[$i]}"; bad=1; }; done',
    'if [ $bad = 0 ]; then echo "All archives finished OK."; else echo "Some archives failed (see above). Failed items were NOT deleted."; fi',
    'exit $bad',
  );
  return lines.join('\n');
}

function commandListDialog() {
  return new Promise((resolve) => {
    const m = $('#modal');
    const close = (v) => { m.hidden = true; m.replaceChildren(); resolve(v); };
    const card = el('div', { className: 'card', style: 'width:560px' }, el('h3', { textContent: 'Custom commands' }),
      el('div', { style: 'color:#99a;font-size:12px;line-height:1.6', innerHTML: '<code>!</code> = selected file name &nbsp; <code>!/</code> = current folder &nbsp; <code>!&amp;</code> = all selected names &nbsp; <code>!!</code> = a literal !<br>Runs on the server in the folder you are browsing, once per selected item. Keep the quotes: <code>"!"</code>' }));
    for (const c of data.commands) {
      card.append(el('div', { className: 'item', style: 'cursor:default' },
        el('div', { className: 'txt' }, el('div', { textContent: c.name }), el('small', { textContent: c.command.replace(/\s*\n\s*/g, ' ↵ '), style: 'max-width:340px' })),
        el('div', { className: 'acts' },
          el('button', { textContent: 'Edit', onclick: () => close({ action: 'edit', c }) }),
          el('button', { textContent: 'Del', className: 'danger', onclick: () => close({ action: 'del', c }) }))));
    }
    card.append(el('div', { className: 'row' },
      el('button', { className: 'btn', textContent: '+ Add command', onclick: () => close({ action: 'add' }) }),
      el('button', { className: 'btn primary', textContent: 'Done', onclick: () => close({ action: 'close' }) })));
    m.replaceChildren(card);
    m.hidden = false;
  });
}

async function editCommands() {
  for (;;) {
    const ch = await commandListDialog();
    if (ch.action === 'close') return;
    if (ch.action === 'del') {
      if (confirm(`Delete command "${ch.c.name}"?`)) { data.commands = data.commands.filter((x) => x !== ch.c); await save(); }
    } else {
      const c = ch.c || { id: uid(), scope: 'any' };
      const r = await modal(ch.c ? 'Edit command' : 'New command', [
        { name: 'name', label: 'Name', value: c.name },
        { name: 'command', label: 'Command (runs on the server; ! = file name)', type: 'textarea', value: c.command },
        { name: 'scope', label: 'Applies to', type: 'select', value: c.scope, options: [{ value: 'any', label: 'Files and folders' }, { value: 'file', label: 'Files only' }, { value: 'dir', label: 'Folders only' }] },
      ]);
      if (r && r.name && r.command.trim()) {
        Object.assign(c, { name: r.name, command: r.command.trim(), scope: r.scope });
        if (!ch.c) data.commands.push(c);
        await save();
      }
    }
  }
}

let openMenu = null;
function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('mousedown', menuOutside, true); }
}
function menuOutside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }

function showCmdMenu(pane, anchor, x, y) {
  closeMenu();
  const menu = el('div', { className: 'ctxmenu' });
  const add = (label, fn) => menu.append(el('div', { className: 'mi', textContent: label, onclick: () => { closeMenu(); fn(); } }));
  const sep = () => menu.append(el('div', { className: 'msep' }));
  add('📦 Compress → S3 → remove local copy…', () => archiveDialog(pane));
  sep();
  data.commands.forEach((c) => add(c.name, () => runCustom(pane, c)));
  sep();
  add('✎ Edit commands…', editCommands);
  document.body.append(menu);
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom; }
  menu.style.left = Math.min(x, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - menu.offsetHeight - 8) + 'px';
  openMenu = menu;
  document.addEventListener('mousedown', menuOutside, true);
}

// ---------- command output panel ----------
let cmdOut = null; // { box, pre, stop, title, jobId, buf, pane }

function buildCmdPanel() {
  const pre = el('pre', { className: 'cmdpre' });
  const title = el('div', { className: 'cmdtitle' });
  const stop = el('button', { className: 'btn danger', textContent: 'Stop', onclick: () => cmdOut.jobId && api.sftp.execCancel(cmdOut.jobId) });
  const box = el('div', { className: 'cmdout', hidden: true }, el('div', { className: 'cmdhead' }, title,
    stop, el('button', { className: 'btn', textContent: '✕', title: 'Hide', onclick: () => { box.hidden = true; } })), pre);
  cmdOut = { box, pre, stop, title, jobId: null, buf: '', pane: null };
  return box;
}

function appendOut(t) {
  let b = cmdOut.buf;
  for (const ch of t.replace(/\r\n/g, '\n')) b = ch === '\r' ? b.slice(0, b.lastIndexOf('\n') + 1) : b + ch; // progress lines overwrite themselves
  if (b.length > 200000) b = b.slice(-150000);
  cmdOut.buf = b;
  cmdOut.pre.textContent = b;
  cmdOut.pre.scrollTop = cmdOut.pre.scrollHeight;
}

async function startExec(pane, cmds, title) {
  if (cmdOut.jobId) return pane.setMsg('A command is still running: wait for it or press Stop.');
  const jobId = uid();
  Object.assign(cmdOut, { jobId, buf: '', pane });
  cmdOut.pre.textContent = '';
  cmdOut.title.textContent = `${title} @ ${pane.path}`;
  cmdOut.stop.hidden = false;
  cmdOut.box.hidden = false;
  const r = await api.sftp.exec(jobId, pane.src, cmds);
  if (r.error) { cmdOut.jobId = null; cmdOut.stop.hidden = true; appendOut(`Error: ${r.error}\n`); }
}

api.sftp.onExecOut((id, t) => { if (id === cmdOut?.jobId) appendOut(t); });
api.sftp.onExecDone((id, r) => {
  if (id !== cmdOut?.jobId) return;
  cmdOut.jobId = null;
  cmdOut.stop.hidden = true;
  appendOut(r.cancelled ? '\n[stopped]\n' : r.code ? '\n[finished with errors]\n' : '\n[finished]\n');
  if (cmdOut.pane.src) cmdOut.pane.go(cmdOut.pane.path);
});

// ---------- the SFTP tab ----------
function openSftp(hostId) {
  if (!sftpTab) createSftpTab();
  sftpTab.panes.forEach((p) => p.refreshHosts());
  activate('sftp');
  const right = sftpTab.panes[1];
  if (hostId && right.hostValue !== hostId) right.setSource(hostId);
}

function createSftpTab() {
  const left = createPane('local');
  const right = createPane('local');
  sftpTab = { panes: [left, right] };
  const div = el('div', { className: 'term sftp' },
    el('div', { className: 'sftp-panes' }, left.root, right.root),
    buildCmdPanel(),
    el('div', { id: 'xfers' }));
  const tabEl = el('div', { className: 'tab', onclick: () => activate('sftp') }, '📁 SFTP',
    el('span', { textContent: '✕', onclick: (e) => { e.stopPropagation(); closeSession('sftp'); } }));
  $('#tabs').append(tabEl);
  $('#terms').append(div);
  $('#empty').hidden = true;
  sessions.set('sftp', {
    term: { focus() {}, dispose() {}, write() {} }, fit: { fit() {} }, div, tabEl, stats: null, cpuHist: [], isSftp: true,
    onClose: () => {
      sftpTab.panes.forEach((p) => p.src && p.src !== 'local' && api.sftp.close(p.src));
      for (const j of xferJobs.keys()) api.sftp.cancel(j);
      if (cmdOut?.jobId) api.sftp.execCancel(cmdOut.jobId);
      closeMenu();
      sftpTab = null;
    },
  });
  left.setSource('local');
  right.setSource('local');
}
