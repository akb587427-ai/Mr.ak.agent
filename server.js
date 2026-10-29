import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store, saveConfig, log, clearHistory } from './store.js';
import { PROVIDERS, resolveLlm, chatCompletion, listModels, detectProviderFromKey } from './llm.js';
import { startWhatsApp, wa, requestPairing, cancelPairing } from './whatsapp.js';

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
  return {
    ...rest,
    hasKey: Boolean(apiKey),
    keyHint: apiKey ? `...${apiKey.slice(-4)}` : '',
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

app.post('/api/config', (req, res) => {
  const b = req.body || {};
  const c = store.config;
  for (const k of ['provider', 'model', 'baseUrl', 'systemPrompt', 'triggerPrefix', 'knowledge', 'ownerNumber']) {
    if (typeof b[k] === 'string') c[k] = b[k].trim();
  }
  for (const k of ['enabled', 'respondToGroups']) {
    if (typeof b[k] === 'boolean') c[k] = b[k];
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
    const llm = resolveLlm(store.config);
    const choice = await chatCompletion({
      ...llm,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    res.json({ ok: true, model: llm.model, reply: (choice.content || '').trim() });
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

server.listen(PORT, '0.0.0.0', () => {
  log('info', `Web app listening on port ${PORT}`);
  startWhatsApp();
});
