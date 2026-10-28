// ---------- port forwarding (Tunnels tab) ----------
const tunnelState = {}; // id -> { state, message, conns }
const TUNNEL_TYPES = { L: 'Local (-L)', R: 'Remote (-R)', D: 'SOCKS5 proxy (-D)' };
const TUNNEL_ICON = { running: '🟢', starting: '🟡', reconnecting: '🟡', error: '🔴', stopped: '⚪' };

api.tunnels.onStatus((id, st) => {
  tunnelState[id] = st;
  if (data && tab === 'tunnels') render();
});

function tunnelSummary(f) {
  const bind = `${f.bindHost || '127.0.0.1'}:${f.bindPort}`;
  const dest = `${f.destHost || '127.0.0.1'}:${f.destPort}`;
  if (f.type === 'D') return `SOCKS5 proxy on ${bind} (through the server)`;
  if (f.type === 'R') return `server ${bind} → this PC ${dest}`;
  return `this PC ${bind} → ${dest} (seen from the server)`;
}

async function editTunnel(f) {
  const isNew = !f;
  f = f || { id: uid(), type: 'L', bindHost: '127.0.0.1', autostart: 'no' };
  if (!data.hosts.length) return alert('Add a host first.');
  const r = await modal(isNew ? 'New tunnel' : 'Edit tunnel', [
    { name: 'name', label: 'Label', value: f.name, placeholder: 'e.g. Database' },
    { name: 'hostId', label: 'Through server', type: 'select', value: f.hostId || data.hosts[0].id, options: data.hosts.map((h) => ({ value: h.id, label: h.name })) },
    { name: 'type', label: 'Type', type: 'select', value: f.type, options: Object.entries(TUNNEL_TYPES).map(([value, label]) => ({ value, label })) },
    { name: 'bindHost', label: 'Listen address (Local/SOCKS: on this PC. Remote: on the server)', value: f.bindHost },
    { name: 'bindPort', label: 'Listen port', value: f.bindPort },
    { name: 'destHost', label: 'Destination host (Local: as seen from the server. Remote: as seen from this PC. Not used for SOCKS)', value: f.destHost, placeholder: '127.0.0.1' },
    { name: 'destPort', label: 'Destination port', value: f.destPort },
    { name: 'autostart', label: 'Start when the vault is unlocked', type: 'select', value: f.autostart, options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] },
  ]);
  if (!r) return;
  const port = (v) => Number.isInteger(+v) && +v >= 1 && +v <= 65535;
  if (!port(r.bindPort)) return alert('Listen port must be 1-65535.');
  if (r.type !== 'D' && !port(r.destPort)) return alert('Destination port must be 1-65535.');
  r.bindHost = r.bindHost.trim() || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(r.bindHost) && r.type !== 'R'
    && !confirm(`"${r.bindHost}" lets other computers on your network use this tunnel. Only do that on a network you trust. Continue?`)) return;
  const wasRunning = tunnelState[f.id]?.state && !['stopped', 'error'].includes(tunnelState[f.id].state);
  if (wasRunning) await api.tunnels.stop(f.id);
  Object.assign(f, r, { destHost: r.destHost.trim(), name: r.name || `${TUNNEL_TYPES[r.type]} ${r.bindPort}` });
  if (isNew) data.forwards.push(f);
  await save();
  if (wasRunning) startTunnel(f);
  render();
}

async function startTunnel(f) {
  tunnelState[f.id] = { state: 'starting', message: '', conns: 0 };
  if (data && tab === 'tunnels') render();
  const r = await api.tunnels.start(f.id);
  if (r.error) tunnelState[f.id] = { state: 'error', message: r.error, conns: 0 };
  if (data && tab === 'tunnels') render();
}

function renderTunnels(p) {
  p.append(el('button', { className: 'btn primary', textContent: '+ New tunnel', onclick: () => editTunnel() }));
  if (!data.forwards.length) p.append(el('div', { textContent: 'No tunnels yet. A tunnel makes a port on the server reachable from this PC (or the other way round) through SSH.', style: 'color:#667;padding:12px;line-height:1.5' }));
  for (const f of data.forwards) {
    const st = tunnelState[f.id] || { state: 'stopped' };
    const on = st.state !== 'stopped' && st.state !== 'error';
    const host = data.hosts.find((h) => h.id === f.hostId);
    const note = st.state === 'error' || st.state === 'reconnecting' ? ` — ${st.message}` : on && st.conns ? ` — ${st.conns} active` : '';
    p.append(item(`${TUNNEL_ICON[st.state] || '⚪'} ${f.name}`, `${tunnelSummary(f)} · ${host ? host.name : '(host deleted)'}${note}`, [
      on ? btn('Stop', () => api.tunnels.stop(f.id)) : btn('Start', () => startTunnel(f)),
      btn('Edit', () => editTunnel(f)),
      btn('Del', async () => {
        if (!confirm(`Delete tunnel ${f.name}?`)) return;
        await api.tunnels.stop(f.id);
        data.forwards = data.forwards.filter((x) => x !== f);
        delete tunnelState[f.id];
        await save();
        render();
      }, 'danger'),
    ]));
  }
  p.append(el('div', { textContent: 'Tunnels reconnect by themselves if the server restarts. They stop when you lock the vault. Listening on 127.0.0.1 keeps them private to this PC.', style: 'color:#667;font-size:12px;padding:12px;line-height:1.5' }));
}

function autostartTunnels() {
  for (const f of data.forwards) if (f.autostart === 'yes') startTunnel(f);
}
