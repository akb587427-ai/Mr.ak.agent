const $ = (id) => document.getElementById(id);
let providers = {};
let initialized = false;
let lastStatus = '';

function setStatus(status, me) {
  const el = $('status');
  el.className = 'status';
  const map = {
    connected: ['ok', me ? `connected · ${me.split('@')[0]}` : 'connected'],
    qr: ['warn', 'waiting for scan'],
    starting: ['', 'starting…'],
    reconnecting: ['warn', 'reconnecting…'],
    logged_out: ['err', 'logged out'],
  };
  const [cls, text] = map[status] || ['', status];
  if (cls) el.classList.add(cls);
  el.textContent = text;
}

function renderQr(wa) {
  const box = $('qrBox');
  if (wa.status === 'connected') {
    box.innerHTML = `<div class="connected-badge"><div style="font-size:40px">✅</div><div>WhatsApp connected</div><div class="hint">${wa.me || ''}</div></div>`;
    return;
  }
  if (wa.qr) {
    box.innerHTML = `<img alt="WhatsApp QR code" src="${wa.qr}" />`;
    return;
  }
  const msg = wa.status === 'logged_out'
    ? 'Logged out. Press “Refresh QR” to link again.'
    : 'Starting WhatsApp… the QR code will appear here in a few seconds.';
  box.innerHTML = `<div class="placeholder">${msg}</div>`;
}

function fillProviders() {
  const sel = $('provider');
  sel.innerHTML = Object.entries(providers)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join('');
}

function applyConfig(cfg) {
  if (!initialized) {
    $('provider').value = cfg.provider;
    $('model').value = cfg.model || '';
    $('baseUrl').value = cfg.baseUrl || '';
    $('systemPrompt').value = cfg.systemPrompt || '';
    $('triggerPrefix').value = cfg.triggerPrefix || '';
    $('enabled').checked = !!cfg.enabled;
    $('respondToGroups').checked = !!cfg.respondToGroups;
    initialized = true;
  }
  $('keyHint').textContent = cfg.hasKey ? `saved (${cfg.keyHint}) — leave blank to keep` : 'not set';
  updateKeyHelp();
}

function updateKeyHelp() {
  const p = providers[$('provider').value];
  const help = $('keyHelp');
  if (!p) { help.innerHTML = ''; return; }
  help.innerHTML = p.keyUrl
    ? `Get a key from <a href="${p.keyUrl}" target="_blank" rel="noopener" style="color:var(--accent2)">${p.keyUrl}</a>`
    : 'Point base URL to any OpenAI-compatible endpoint.';
}

function renderLogs(logs) {
  const el = $('logs');
  el.innerHTML = logs
    .map((l) => {
      const t = new Date(l.ts).toLocaleTimeString();
      const extra = l.extra ? ' ' + l.extra : '';
      return `<div class="log-line ${l.level}"><span class="t">${t}</span>${escapeHtml(l.message)}${escapeHtml(extra)}</div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function applyState(data) {
  providers = data.providers || {};
  if (!$('provider').options.length) fillProviders();
  setStatus(data.wa.status, data.wa.me);
  renderQr(data.wa);
  applyConfig(data.config);
  renderLogs(data.logs || []);
  $('waMsg').textContent = data.wa.lastError && data.wa.status !== 'connected' ? data.wa.lastError : '';
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({}));
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') applyState(msg.data);
    } catch {}
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

$('provider').addEventListener('change', () => {
  const p = providers[$('provider').value];
  if (p) {
    $('model').value = p.defaultModel || '';
    $('baseUrl').value = p.baseUrl || '';
  }
  updateKeyHelp();
});

$('saveBtn').addEventListener('click', async () => {
  const msg = $('cfgMsg');
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  const body = {
    provider: $('provider').value,
    model: $('model').value,
    baseUrl: $('baseUrl').value,
    systemPrompt: $('systemPrompt').value,
    triggerPrefix: $('triggerPrefix').value,
    enabled: $('enabled').checked,
    respondToGroups: $('respondToGroups').checked,
  };
  const key = $('apiKey').value.trim();
  if (key) body.apiKey = key;
  const r = await post('/api/config', body);
  if (r.ok) {
    $('apiKey').value = '';
    msg.className = 'msg ok';
    msg.textContent = 'Saved.';
    initialized = false;
  } else {
    msg.className = 'msg err';
    msg.textContent = r.error || 'Could not save.';
  }
});

$('testBtn').addEventListener('click', async () => {
  const msg = $('cfgMsg');
  msg.className = 'msg';
  msg.textContent = 'Testing AI…';
  const r = await post('/api/test-llm');
  if (r.ok) {
    msg.className = 'msg ok';
    msg.textContent = `AI responded with "${r.reply}" using ${r.model}.`;
  } else {
    msg.className = 'msg err';
    msg.textContent = r.error || 'Test failed.';
  }
});

$('restartBtn').addEventListener('click', () => post('/api/restart'));
$('logoutBtn').addEventListener('click', async () => {
  if (confirm('Log out of WhatsApp and unlink this device?')) await post('/api/logout');
});
$('clearHistoryBtn').addEventListener('click', async () => {
  await post('/api/clear-history');
  const msg = $('cfgMsg');
  msg.className = 'msg ok';
  msg.textContent = 'Chat memory cleared.';
});

connectWs();
