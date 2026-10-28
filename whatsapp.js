import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  delay,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { store, log } from './store.js';
import { respond } from './agent.js';

const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), 'data', 'auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });
const logger = pino({ level: 'silent' });

export const wa = {
  status: 'starting',
  qrDataUrl: null,
  me: null,
  lastError: null,
  sock: null,
  reconnectAttempts: 0,
};

let starting = false;

export function startWhatsApp() {
  if (starting) return;
  starting = true;
  connect()
    .catch((e) => log('error', 'connect() failed', e.message))
    .finally(() => {
      starting = false;
    });
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });
  wa.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        wa.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 340 });
        wa.status = 'qr';
        log('info', 'QR ready — scan it from WhatsApp > Linked devices');
      } catch (e) {
        log('error', 'QR generation failed', e.message);
      }
    }
    if (connection === 'open') {
      wa.status = 'connected';
      wa.qrDataUrl = null;
      wa.lastError = null;
      wa.reconnectAttempts = 0;
      wa.me = sock.user ? jidNormalizedUser(sock.user.id) : null;
      log('info', `WhatsApp connected as ${wa.me}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      wa.status = loggedOut ? 'logged_out' : 'reconnecting';
      wa.qrDataUrl = null;
      wa.lastError = lastDisconnect?.error?.message || `code ${code}`;
      log('warn', `Connection closed (code ${code})`);
      if (loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        wa.reconnectAttempts = 0;
        setTimeout(startWhatsApp, 1500);
      } else {
        wa.reconnectAttempts++;
        setTimeout(startWhatsApp, Math.min(15000, 1000 * wa.reconnectAttempts));
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      handleMessage(sock, msg).catch((e) => log('error', 'message handler failed', e.message));
    }
  });
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  if (isJidGroup(jid) && !store.config.respondToGroups) return;

  const type = getContentType(msg.message);
  if (type !== 'conversation' && type !== 'extendedTextMessage') return;
  const text =
    (type === 'conversation' ? msg.message.conversation : msg.message.extendedTextMessage?.text || '').trim();
  if (!text) return;

  let content = text;
  if (store.config.triggerPrefix) {
    if (!text.startsWith(store.config.triggerPrefix)) return;
    content = text.slice(store.config.triggerPrefix.length).trim();
    if (!content) return;
  }
  if (!store.config.enabled) return;

  log('info', `Incoming from ${jid}: ${content.slice(0, 80)}`);
  try {
    const reply = await respond(jid, content);
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await delay(300);
    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    log('info', `Replied to ${jid}`);
  } catch (e) {
    log('error', 'Failed to reply', e.message);
    await sock.sendMessage(jid, { text: `Agent error: ${e.message}` }).catch(() => {});
  }
}
