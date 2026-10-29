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
import { store, log, getHistory, appendHistory } from './store.js';
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
  pairing: { requested: false, number: null, code: null, error: null },
};

let starting = false;
let pendingPairingNumber = null;

// Send a WhatsApp DM to the owner (Arslan) so he can pick up the lead himself.
export async function notifyOwner({ customer, reason }) {
  const owner = String(store.config.ownerNumber || '').replace(/\D/g, '');
  if (!owner) {
    log('warn', 'No owner number set — lead alert not sent. Add one in AI settings.');
    return false;
  }
  if (!wa.sock || wa.status !== 'connected') {
    log('warn', 'WhatsApp not connected — owner alert not sent.');
    return false;
  }
  const c = customer || {};
  const lines = [
    '🔔 New customer enquiry',
    '',
    c.name ? `Name: ${c.name}` : null,
    c.businessName ? `Business: ${c.businessName}` : null,
    c.businessType ? `Type: ${c.businessType}` : null,
    c.city ? `City: ${c.city}` : null,
    c.product ? `Wants: ${c.product}` : null,
    c.budget ? `Budget: ${c.budget}` : null,
    c.timeline ? `Timeline: ${c.timeline}` : null,
    reason ? `Reason: ${reason}` : null,
    '',
    c.jid ? `Chat: ${c.jid.split('@')[0]}` : null,
    'Reply to this customer directly on WhatsApp.',
  ].filter((l) => l !== null);
  try {
    await wa.sock.sendMessage(`${owner}@s.whatsapp.net`, { text: lines.join('\n') });
    log('info', `Owner alerted about ${c.name || c.jid || 'a customer'}`);
    return true;
  } catch (e) {
    log('error', 'Owner alert failed', e.message);
    return false;
  }
}

// The first reply to a brand-new customer is generated from this fixed, polished
// template so it always looks professional and on-brand.
function welcomeText() {
  return [
    'Assalam o Alaikum and welcome to TECH ARSLAN SOFTWARE SOLUTIONS! 👋',
    '',
    'I am the official assistant for Arslan Akram and our team. We build business software for pharmacies, laboratories, hospitals, schools, restaurants, hotels, and retail businesses.',
    '',
    'To point you to the right solution, may I ask: what kind of business do you run, and what would you like the software to do for you?',
    '',
    'You can also tell me your city, and I will arrange a free live demo on WhatsApp with our team.',
  ].join('\n');
}

export function startWhatsApp() {
  if (starting) return;
  starting = true;
  connect()
    .catch((e) => log('error', 'connect() failed', e.message))
    .finally(() => {
      starting = false;
    });
}

// Link without a QR code: WhatsApp shows the code on the phone after the user
// enters their number under "Link with phone number instead".
export function requestPairing(phoneNumber) {
  if (wa.status === 'connected') throw new Error('Already connected. Log out first to link another number.');
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Enter the full international number without "+", e.g. 923001234567');
  }
  pendingPairingNumber = digits;
  wa.pairing = { requested: true, number: digits, code: null, error: null };
  wa.qrDataUrl = null;
  wa.status = 'pairing';
  log('info', `Pairing code requested for ${digits}`);
  setTimeout(tryRequestPairing, 400);
  return wa.pairing;
}

export function cancelPairing() {
  pendingPairingNumber = null;
  wa.pairing = { requested: false, number: null, code: null, error: null };
  if (wa.status === 'pairing') wa.status = 'starting';
  log('info', 'Pairing cancelled — switching back to QR');
  return wa.pairing;
}

async function tryRequestPairing() {
  if (!pendingPairingNumber || !wa.sock || wa.pairing.code) return;
  try {
    const code = await wa.sock.requestPairingCode(pendingPairingNumber);
    wa.pairing.code = code;
    wa.pairing.error = null;
    wa.status = 'pairing';
    log('info', `Pairing code ready: ${code}`);
  } catch (e) {
    // The socket may still be connecting; the next QR tick will retry.
    if (/connection|closed|not open|timed out/i.test(e.message)) {
      log('info', 'Socket not ready for pairing yet, will retry');
      return;
    }
    wa.pairing.error = e.message;
    log('error', 'Pairing code request failed', e.message);
  }
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

  sock.ev.on('error', (e) => log('error', 'socket error', e?.message || String(e)));

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      if (pendingPairingNumber) {
        await tryRequestPairing();
      } else {
        try {
          wa.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 340 });
          wa.status = 'qr';
          log('info', 'QR ready — scan it from WhatsApp > Linked devices');
        } catch (e) {
          log('error', 'QR generation failed', e.message);
        }
      }
    }
    if (connection === 'open') {
      wa.status = 'connected';
      wa.qrDataUrl = null;
      wa.lastError = null;
      wa.reconnectAttempts = 0;
      pendingPairingNumber = null;
      wa.pairing = { requested: false, number: null, code: null, error: null };
      wa.me = sock.user ? jidNormalizedUser(sock.user.id) : null;
      log('info', `WhatsApp connected as ${wa.me}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      wa.status = loggedOut ? 'logged_out' : 'reconnecting';
      wa.qrDataUrl = null;
      wa.lastError = lastDisconnect?.error?.message || `code ${code}`;
      if (wa.pairing.requested && !loggedOut) {
        wa.pairing.code = null;
        pendingPairingNumber = wa.pairing.number;
      }
      log('warn', `Connection closed (code ${code})`);
      if (loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        wa.reconnectAttempts = 0;
        pendingPairingNumber = null;
        wa.pairing = { requested: false, number: null, code: null, error: null };
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

  // Newer WhatsApp accounts address chats by a "@lid" id. Send the reply back to the
  // phone-number jid when it is available, so the customer actually receives it.
  const replyJid = jid.endsWith('@lid') && msg.key.remoteJidAlt ? msg.key.remoteJidAlt : jid;

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
    await sock.sendPresenceUpdate('composing', replyJid).catch(() => {});

    // A brand-new customer who just says hello gets the polished welcome, so the
    // first impression is always professional and consistent.
    const firstContact = getHistory(jid).length === 0;
    const greetingOnly = /^(as?alam|assalam|salam|aoa|hi|hey|hello|helo|hy|good\s*(morning|evening|afternoon)|kya haal|kaise ho)[\s!.,?]*$/i.test(
      content,
    );
    if (firstContact && greetingOnly) {
      const text = welcomeText();
      appendHistory(jid, 'user', content);
      appendHistory(jid, 'assistant', text);
      await delay(300);
      await sock.sendMessage(replyJid, { text }, { quoted: msg });
      log('info', `Welcomed new customer ${replyJid}`);
      return;
    }

    const { reply } = await respond(jid, content, { notifyOwner });
    await delay(300);
    await sock.sendMessage(replyJid, { text: reply }, { quoted: msg });
    log('info', `Replied to ${replyJid}`);
  } catch (e) {
    log('error', 'Failed to reply', e.message);
    const friendly =
      'Sorry, the assistant is not set up correctly right now. Please try again later.';
    await sock.sendMessage(replyJid, { text: friendly }, { quoted: msg }).catch(() => {});
  }
}
