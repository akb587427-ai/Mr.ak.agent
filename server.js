import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store, saveConfig, log, clearHistory } from './store.js';
import { PROVIDERS, resolveEndpoints, chatCompletion, listModels, detectProviderFromKey, splitKeys, endpointSummary, resetPacing } from './llm.js';
import { startWhatsApp, wa, requestPairing, cancelPairing, notifyOwner } from './whatsapp.js';
import { callStats } from './calls.js';
import { synthesizeSpeech, voiceReady, ffmpegAvailable, VOICES } from './voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 12000);

// Keep the process alive through transient network or Baileys errors, otherwise a
// single stray rejection would take the whole web app down.
process.on('uncaughtException', (e) => {
  log('error', 'uncaughtException', e?.stack || e?.message || String(e));
});
process.on('unhandledRejection', (e) => {
  log('error', 'unhandledRejection', e?.stack || e?.message || String(e));
});
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), 'data', 'auth');

function publicConfig() {
  const { apiKey, ...rest } = store.config;
  const keys = splitKeys(apiKey);
  return {
    ...rest,
    hasKey: keys.length > 0,
    keyHint: keys.length ? `...${keys[0].slice(-4)}` : '',
    keyCount: keys.length,
    endpoints: keys.length ? endpointSummary(store.config).map((e) => ({ provider: e.provider, label: e.label })) : [],
  };
}

function state() {
  return {
    wa: {
      status: wa.status,
      me: wa.me,
      lastError: wa.lastError,
      qr: wa.qrDataUrl,
      pairing: wa.pairing,
    },
    config: publicConfig(),
    providers: PROVIDERS,
    calls: { ...callStats, ffmpeg: ffmpegAvailable(), voiceReady: voiceReady() },
    voices: VOICES,
    health: healthState(),
    logs: store.logs.slice(-80).reverse(),
  };
}

app.get('/api/state', (_req, res) => res.json(state()));

app.get('/api/leads', (_req, res) => res.json({ ok: true, leads: store.leads.slice().reverse() }));

app.get('/api/customers', (_req, res) => {
  const list = Object.values(store.customers).sort((a, b) =>
    String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')),
  );
  res.json({ ok: true, customers: list });
});

app.post('/api/test-alert', async (_req, res) => {
  try {
    const { notifyOwner } = await import('./whatsapp.js');
    const sent = await notifyOwner({
      customer: {
        name: 'Test Customer',
        businessName: 'Test Business',
        businessType: 'pharmacy',
        city: 'Lahore',
        product: 'Pharmacy POS',
        phone: '923001234567',
        jid: '923001234567@s.whatsapp.net',
      },
      reason: 'This is a test alert from the dashboard.',
    });
    res.json(
      sent
        ? { ok: true }
        : { ok: false, error: 'Could not send. Check that an owner number is set and WhatsApp is connected.' },
    );
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Exercises the same speech path the call handler and voice replies use, so the
// dashboard can prove TTS works without waiting for a real call.
app.post('/api/test-voice', async (req, res) => {
  try {
    if (!voiceReady()) return res.status(400).json({ ok: false, error: 'No API key configured.' });
    if (!ffmpegAvailable()) return res.status(400).json({ ok: false, error: 'ffmpeg is not installed on this host.' });
    const text = (
      req.body?.text ||
      'Assalam o Alaikum! Yeh TECH ARSLAN SOFTWARE SOLUTIONS ka AI assistant hai. Aap ka call humein mil gaya, please isi chat par apni zaroorat batayein.'
    ).trim();
    const started = Date.now();
    const audio = await synthesizeSpeech(text);
    // With send=true the note is also delivered to the owner's own DM, which proves
    // WhatsApp actually renders it as a playable voice note.
    let sent = false;
    if (req.body?.send === true) {
      const { wa } = await import('./whatsapp.js');
      const owner = String(store.config.ownerNumber || '').replace(/\D/g, '');
      if (owner && wa.sock && wa.status === 'connected') {
        await wa.sock.sendMessage(`${owner}@s.whatsapp.net`, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        sent = true;
      }
    }
    log('info', `Voice test generated ${audio.length} bytes in ${Date.now() - started}ms${sent ? ' and sent to owner' : ''}`);
    res.json({ ok: true, bytes: audio.length, ms: Date.now() - started, mime: 'audio/ogg; codecs=opus', sent });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/config', (req, res) => {
  const b = req.body || {};
  const c = store.config;
  for (const k of ['provider', 'model', 'baseUrl', 'systemPrompt', 'triggerPrefix', 'knowledge', 'ownerNumber', 'ttsVoice']) {
    if (typeof b[k] === 'string') c[k] = b[k].trim();
  }
  for (const k of ['enabled', 'respondToGroups', 'voiceReplies']) {
    if (typeof b[k] === 'boolean') c[k] = b[k];
  }
  if (b.calls && typeof b.calls === 'object') {
    c.calls = { ...(c.calls || {}) };
    if (['off', 'text', 'voice'].includes(b.calls.mode)) c.calls.mode = b.calls.mode;
    if (typeof b.calls.notifyOwner === 'boolean') c.calls.notifyOwner = b.calls.notifyOwner;
    if (typeof b.calls.greeting === 'string') c.calls.greeting = b.calls.greeting.trim();
  }
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKey = b.apiKey.trim();
  if (b.clearApiKey === true) c.apiKey = '';

  // Fill missing provider details from the key so a pasted Groq/OpenAI key works
  // even when the provider dropdown was left on "custom".
  const preset = PROVIDERS[c.provider];
  const needsBaseUrl = !c.baseUrl && !preset?.baseUrl;
  const needsModel = !c.model && !preset?.defaultModel;
  if (c.apiKey && (needsBaseUrl || needsModel)) {
    const detected = detectProviderFromKey(c.apiKey);
    if (detected) {
      const dp = PROVIDERS[detected];
      c.provider = detected;
      if (needsBaseUrl) c.baseUrl = dp.baseUrl || '';
      if (needsModel) c.model = dp.defaultModel || '';
    }
  }

  // A provider or key change invalidates any limit recorded against the old one.
  resetPacing();
  saveConfig();
  log('info', 'Settings updated');
  broadcast();
  res.json({ ok: true, config: publicConfig() });
});

app.post('/api/models', async (_req, res) => {
  try {
    const result = await listModels(store.config);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/test-llm', async (_req, res) => {
  try {
    const endpoints = resolveEndpoints(store.config);
    const choice = await chatCompletion({
      endpoints,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    res.json({ ok: true, model: endpoints[0].model, keys: endpoints.length, reply: (choice.content || '').trim() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/pair', (req, res) => {
  try {
    const pairing = requestPairing(req.body?.number);
    broadcast();
    res.json({ ok: true, pairing });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/pair/cancel', (_req, res) => {
  const pairing = cancelPairing();
  broadcast();
  res.json({ ok: true, pairing });
});

app.post('/api/restart', (_req, res) => {
  log('info', 'Restarting WhatsApp connection');
  try {
    wa.sock?.end?.(new Error('restart requested'));
  } catch {}
  wa.status = 'starting';
  setTimeout(startWhatsApp, 800);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  log('warn', 'Logging out and clearing WhatsApp session');
  try {
    wa.sock?.logout?.();
  } catch {}
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  cancelPairing();
  wa.status = 'starting';
  wa.me = null;
  wa.qrDataUrl = null;
  setTimeout(startWhatsApp, 1200);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/clear-history', (_req, res) => {
  clearHistory();
  log('info', 'Chat history cleared');
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast() {
  const payload = JSON.stringify({ type: 'state', data: state() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', data: state() }));
});

setInterval(broadcast, 2500);

// A dead or disabled API key takes the whole agent offline silently — customers get
// no reply and the owner has no idea. Check the key periodically and DM the owner the
// moment it breaks, with the exact reason, so it can be replaced.
const health = { ok: null, reason: '', notified: false, checkedAt: 0 };
export function healthState() {
  return { ...health };
}

async function checkKey() {
  const preset = PROVIDERS[store.config.provider] || {};
  if (!splitKeys(store.config.apiKey).length && !preset.keyless) {
    health.ok = false;
    health.reason = 'No API key saved';
  } else {
    try {
      await chatCompletion({
        endpoints: resolveEndpoints(store.config),
        messages: [{ role: 'user', content: 'ping' }],
      });
      health.ok = true;
      health.reason = '';
      health.notified = false;
    } catch (e) {
      health.ok = false;
      health.reason = String(e?.message || e).slice(0, 300);
    }
  }
  health.checkedAt = Date.now();

  if (!health.ok && !health.notified && wa.status === 'connected') {
    health.notified = true;
    const auth = /401|403|UNAUTHENTICATED|PERMISSION_DENIED|deleted or disabled|API key not valid/i.test(health.reason);
    const body = auth
      ? [
          '⚠️ AI key band ho gayi hai — agent jawab nahi de raha',
          '',
          'Aap ki Gemini/LLM API key kaam nahi kar rahi. Neeche wajah likhi hai.',
          'Nayi key banayein (aistudio.google.com/apikey) aur dashboard ke AI settings mein paste karke Save karein.',
          '',
          `Wajah: ${health.reason}`,
        ]
      : ['⚠️ AI jawab fail ho raha hai', '', `Wajah: ${health.reason}`];
    await notifyOwner({ customer: {}, reason: body.join('\n') }).catch(() => {});
  }
}

setInterval(checkKey, 10 * 60 * 1000);
setTimeout(checkKey, 45 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  log('info', `Web app listening on port ${PORT}`);
  startWhatsApp();
});
