import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store, saveConfig, log, clearHistory } from './store.js';
import { PROVIDERS, resolveLlm, chatCompletion } from './llm.js';
import { startWhatsApp, wa } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 12000);
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
    wa: { status: wa.status, me: wa.me, lastError: wa.lastError, qr: wa.qrDataUrl },
    config: publicConfig(),
    providers: PROVIDERS,
    logs: store.logs.slice(-80).reverse(),
  };
}

app.get('/api/state', (_req, res) => res.json(state()));

app.post('/api/config', (req, res) => {
  const b = req.body || {};
  const c = store.config;
  for (const k of ['provider', 'model', 'baseUrl', 'systemPrompt', 'triggerPrefix']) {
    if (typeof b[k] === 'string') c[k] = b[k].trim();
  }
  for (const k of ['enabled', 'respondToGroups']) {
    if (typeof b[k] === 'boolean') c[k] = b[k];
  }
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKey = b.apiKey.trim();
  if (b.clearApiKey === true) c.apiKey = '';
  saveConfig();
  log('info', 'Settings updated');
  broadcast();
  res.json({ ok: true, config: publicConfig() });
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
