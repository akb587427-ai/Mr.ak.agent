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
    pairing: ['warn', 'pairing code mode'],
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
  if (wa.status === 'pairing' && wa.pairing?.code) {
    box.innerHTML = `<div class="connected-badge"><div style="font-size:40px">🔢</div><div>Pairing mode</div><div class="hint">Enter the code shown below on your phone</div></div>`;
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

function renderPairing(wa) {
  const p = wa.pairing || {};
  const box = $('pairBox');
  const codeEl = $('pairCode');
  const noteEl = $('pairNote');
  const msg = $('pairMsg');
  if (p.requested) {
    $('pairDetails').open = true;
    box.hidden = false;
    codeEl.textContent = p.code ? p.code : '• • • • • • • •';
    noteEl.textContent = p.code
      ? 'On your phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.'
      : 'Requesting a code from WhatsApp…';
    if (p.error) {
      msg.className = 'msg err';
      msg.textContent = p.error;
    } else if (p.code) {
      msg.className = 'msg ok';
      msg.textContent = `Code requested for ${p.number}.`;
    } else {
      msg.className = 'msg';
      msg.textContent = 'Please wait…';
    }
  } else {
    box.hidden = true;
    codeEl.textContent = '— — — — — — — —';
  }
}

function fillProviders() {
  const sel = $('provider');
  sel.innerHTML = Object.entries(providers)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join('');
}

function fillVoices(voices) {
  const sel = $('ttsVoice');
  sel.innerHTML = voices.map((v) => `<option value="${v.id}">${v.label}</option>`).join('');
  sel.value = 'Charon';
}

// A dead API key is invisible in chat: the customer just gets silence. Surface it
// loudly on the dashboard so the owner knows to paste a new key.
function renderHealth(h) {
  const el = $('keyAlert');
  if (!h || h.ok !== false) {
    el.hidden = true;
    return;
  }
  const auth = /401|403|UNAUTHENTICATED|PERMISSION_DENIED|deleted or disabled|API key not valid/i.test(h.reason || '');
  $('keyAlertMsg').textContent = auth
    ? 'Aap ki API key delete ya disable ho gayi hai. Nayi key banayein (aistudio.google.com/apikey), AI settings mein paste karke Save karein.'
    : h.reason || 'AI jawab fail ho raha hai.';
  el.hidden = false;
}

function applyConfig(cfg) {
  if (!initialized) {
    $('provider').value = cfg.provider;
    $('model').value = cfg.model || '';
    $('baseUrl').value = cfg.baseUrl || '';
    $('systemPrompt').value = cfg.systemPrompt || '';
    $('ownerNumber').value = cfg.ownerNumber || '';
    $('knowledge').value = cfg.knowledge || '';
    $('triggerPrefix').value = cfg.triggerPrefix || '';
    $('enabled').checked = !!cfg.enabled;
    $('respondToGroups').checked = !!cfg.respondToGroups;
    $('voiceReplies').checked = cfg.voiceReplies !== false;
    $('callsMode').value = cfg.calls?.mode || 'voice';
    $('callsNotifyOwner').checked = cfg.calls?.notifyOwner !== false;
    $('callsGreeting').value = cfg.calls?.greeting || '';
    if (cfg.ttsVoice && [...$('ttsVoice').options].some((o) => o.value === cfg.ttsVoice)) {
      $('ttsVoice').value = cfg.ttsVoice;
    }
    initialized = true;
  }
  $('keyHint').textContent = cfg.hasKey
    ? `${cfg.keyCount > 1 ? cfg.keyCount + ' keys saved' : 'saved'} (${cfg.keyHint}) — leave blank to keep`
    : 'not set';
  updateKeyHelp();
}

function updateKeyHelp() {
  const p = providers[$('provider').value];
  const help = $('keyHelp');
  if (!help) return;
  const extra =
    ' You can paste more than one key, separated by commas. Each free key has its own per-minute limit, so two or three keys together keep the agent replying even when customers are busy.';
  if (p && p.keyless) {
    help.innerHTML =
      'This provider is free and needs no key. It works on its own, and it stays in the queue as a backstop when you add your own keys. It allows about one reply every 30 seconds, so add a free Gemini key below for heavy traffic.' +
      extra;
    return;
  }
  help.innerHTML = p && p.keyUrl
    ? `Get a free key from <a href="${p.keyUrl}" target="_blank" rel="noopener" style="color:var(--accent2)">${p.keyUrl}</a>.${extra}`
    : `Point base URL to any OpenAI-compatible endpoint.${extra}`;
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

function renderLeads(customers) {
  const el = $('leads');
  if (!customers.length) {
    el.innerHTML = '<div class="log-line">No customers yet. Details appear here as the agent talks to them.</div>';
    return;
  }
  const stageLabel = {
    new: 'new',
    interested: 'interested',
    demo_pending: 'demo pending',
    demo_done: 'demo done',
    negotiating: 'negotiating',
    ready_to_buy: 'ready to buy',
    not_interested: 'not interested',
  };
  el.innerHTML = customers
    .map((c) => {
      const t = c.lastSeen ? new Date(c.lastSeen).toLocaleString() : '';
      const number = c.phone || (!c.jid?.endsWith('@lid') ? (c.jid || '').split('@')[0] : '');
      const rows = [
        ['Name', c.name],
        ['WhatsApp', number],
        ['Business', c.businessName],
        ['Type', c.businessType],
        ['City', c.city],
        ['Wants', c.product],
        ['Budget', c.budget],
        ['Timeline', c.timeline],
        ['Email', c.email],
      ].filter(([, v]) => v);
      const stage = c.stage ? `<span class="badge">${escapeHtml(stageLabel[c.stage] || c.stage)}</span>` : '';
      return `<div class="log-line info"><span class="t">${t}</span><b>${escapeHtml(c.name || number || 'Unknown')}</b> ${stage}
        ${rows.map(([k, v]) => `<div class="kv"><span>${k}</span>${escapeHtml(v)}</div>`).join('')}
        ${c.summary ? `<div class="kv"><span>Notes</span>${escapeHtml(c.summary)}</div>` : ''}</div>`;
    })
    .join('');
}

async function loadLeads() {
  try {
    const r = await fetch('/api/customers').then((x) => x.json());
    renderLeads(r.customers || []);
  } catch {}
}

function applyState(data) {
  providers = data.providers || {};
  if (!$('provider').options.length) fillProviders();
  if (data.voices && !$('ttsVoice').options.length) fillVoices(data.voices);
  setStatus(data.wa.status, data.wa.me);
  renderQr(data.wa);
  renderPairing(data.wa);
  renderHealth(data.health);
  applyConfig(data.config);
  renderLogs(data.logs || []);
  $('waMsg').textContent = data.wa.lastError && data.wa.status !== 'connected' ? data.wa.lastError : '';
  renderCalls(data.calls);
}

function renderCalls(calls) {
  const el = $('callStatus');
  if (!el || !calls) return;
  const parts = [];
  if (!calls.ffmpeg) parts.push('ffmpeg missing on host');
  if (!calls.voiceReady) parts.push('no API key');
  if (calls.total) {
    const when = calls.lastAt ? new Date(calls.lastAt).toLocaleTimeString() : '';
    parts.unshift(`${calls.total} call${calls.total > 1 ? 's' : ''} handled${calls.lastFrom ? ` — last from ${calls.lastFrom}` : ''}${when ? ` at ${when}` : ''}`);
  } else {
    parts.unshift('No calls received yet');
  }
  el.textContent = parts.join(' · ');
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

$('loadModelsBtn').addEventListener('click', async () => {
  const msg = $('cfgMsg');
  msg.className = 'msg';
  msg.textContent = 'Loading models…';
  // Save current settings first so the server can use the key you just typed.
  const key = $('apiKey').value.trim();
  const body = {
    provider: $('provider').value,
    model: $('model').value,
    baseUrl: $('baseUrl').value,
  };
  if (key) body.apiKey = key;
  await post('/api/config', body);
  if (key) $('apiKey').value = '';
  const r = await post('/api/models');
  if (!r.ok) {
    msg.className = 'msg err';
    msg.textContent = r.error || 'Could not load models.';
    return;
  }
  const list = $('modelList');
  list.innerHTML = (r.models || []).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  if (r.models?.length) {
    if (!$('model').value) $('model').value = r.models[0];
    msg.className = 'msg ok';
    msg.textContent = `Found ${r.models.length} models. Click the model box to choose one.`;
  } else {
    msg.className = 'msg err';
    msg.textContent = 'No models returned by the provider.';
  }
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
    ownerNumber: $('ownerNumber').value,
    knowledge: $('knowledge').value,
    triggerPrefix: $('triggerPrefix').value,
    enabled: $('enabled').checked,
    respondToGroups: $('respondToGroups').checked,
    voiceReplies: $('voiceReplies').checked,
    ttsVoice: $('ttsVoice').value,
    calls: {
      mode: $('callsMode').value,
      notifyOwner: $('callsNotifyOwner').checked,
      greeting: $('callsGreeting').value,
    },
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

$('pairBtn').addEventListener('click', async () => {
  const msg = $('pairMsg');
  const number = $('pairNumber').value.trim();
  msg.className = 'msg';
  if (!number) {
    msg.className = 'msg err';
    msg.textContent = 'Enter your WhatsApp number first.';
    return;
  }
  msg.textContent = 'Requesting code…';
  const r = await post('/api/pair', { number });
  if (!r.ok) {
    msg.className = 'msg err';
    msg.textContent = r.error || 'Could not request a pairing code.';
  }
});

$('cancelPairBtn').addEventListener('click', async () => {
  await post('/api/pair/cancel');
  const msg = $('pairMsg');
  msg.className = 'msg';
  msg.textContent = 'Switched back to QR. Press “Refresh QR” if no code appears.';
});

$('restartBtn').addEventListener('click', () => post('/api/restart'));
$('testAlertBtn').addEventListener('click', async () => {
  const msg = $('cfgMsg');
  msg.className = 'msg';
  msg.textContent = 'Sending test alert…';
  // Save the number first so the server can use it.
  await post('/api/config', { ownerNumber: $('ownerNumber').value });
  const r = await post('/api/test-alert');
  if (r.ok) {
    msg.className = 'msg ok';
    msg.textContent = 'Test alert sent. Check your WhatsApp.';
  } else {
    msg.className = 'msg err';
    msg.textContent = r.error || 'Could not send the test alert.';
  }
});
$('testVoiceBtn').addEventListener('click', async () => {
  const msg = $('cfgMsg');
  msg.className = 'msg';
  msg.textContent = 'Generating voice… (a few seconds)';
  // Save the chosen voice and call settings first so the sample uses them.
  await post('/api/config', {
    ttsVoice: $('ttsVoice').value,
    voiceReplies: $('voiceReplies').checked,
    calls: { mode: $('callsMode').value, notifyOwner: $('callsNotifyOwner').checked, greeting: $('callsGreeting').value },
  });
  const owner = $('ownerNumber').value.trim();
  if (owner) await post('/api/config', { ownerNumber: owner });
  const r = await post('/api/test-voice', { send: true });
  if (r.ok) {
    msg.className = 'msg ok';
    msg.textContent = r.sent
      ? `Voice sample sent to your WhatsApp — ${(r.bytes / 1024).toFixed(0)} KB in ${(r.ms / 1000).toFixed(1)}s.`
      : `Voice works (${(r.bytes / 1024).toFixed(0)} KB), but WhatsApp is not connected so nothing was sent.`;
  } else {
    msg.className = 'msg err';
    msg.textContent = r.error || 'Voice test failed.';
  }
});
$('refreshLeadsBtn').addEventListener('click', loadLeads);
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
loadLeads();
setInterval(loadLeads, 15000);
