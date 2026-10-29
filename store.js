import fs from 'fs';
import path from 'path';
import { DEFAULT_KNOWLEDGE } from './knowledge.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_LOG = 300;
const MAX_HISTORY = 16;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function defaultConfig() {
  return {
    provider: 'pollinations',
    apiKey: '',
    model: '',
    baseUrl: '',
    systemPrompt:
      'You are the official WhatsApp sales and support assistant for TECH ARSLAN SOFTWARE SOLUTIONS. You sell our business software and our online digital services. Be warm, professional and brief. Use plain text only, no markdown.',
    knowledge: DEFAULT_KNOWLEDGE,
    ownerNumber: '',
    enabled: true,
    respondToGroups: false,
    triggerPrefix: '',
    // Reply to a voice note with a voice note.
    voiceReplies: true,
    // What to do when someone calls the number. Baileys cannot carry call audio, so
    // the call is rejected and the agent follows up on chat instead.
    calls: {
      mode: 'voice', // off | text | voice
      notifyOwner: true,
      greeting: '',
    },
  };
}

export const store = {
  config: { ...defaultConfig(), ...readJson(CONFIG_FILE, {}) },
  history: readJson(HISTORY_FILE, {}),
  customers: {},
  logs: [],
};

// On a fresh host the volume is empty, so allow the first boot to be seeded from the
// environment. Anything already saved wins, because the dashboard writes the same
// fields and a redeploy must not overwrite a key the user set there.
let seeded = false;
if (!store.config.apiKey && process.env.LLM_API_KEY) {
  store.config.apiKey = process.env.LLM_API_KEY.trim();
  seeded = true;
}
if (!store.config.ownerNumber && process.env.OWNER_NUMBER) {
  store.config.ownerNumber = process.env.OWNER_NUMBER.trim();
  seeded = true;
}
if (seeded) writeJson(CONFIG_FILE, store.config);

const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
store.customers = readJson(CUSTOMERS_FILE, {});

// What the agent remembers about each customer across conversations.
const CUSTOMER_FIELDS = [
  'name',
  'businessName',
  'businessType',
  'city',
  'product',
  'phone',
  'email',
  'budget',
  'timeline',
  'notes',
  'stage',
  'summary',
];

export function getCustomer(jid) {
  return store.customers[jid] || null;
}

export function updateCustomer(jid, patch) {
  const cur = store.customers[jid] || { jid, firstSeen: new Date().toISOString() };
  for (const k of CUSTOMER_FIELDS) {
    if (typeof patch?.[k] === 'string' && patch[k].trim()) cur[k] = patch[k].trim();
  }
  cur.lastSeen = new Date().toISOString();
  store.customers[jid] = cur;
  writeJson(CUSTOMERS_FILE, store.customers);
  return cur;
}

export function markOwnerAlerted(jid) {
  const c = store.customers[jid];
  if (!c) return;
  c.ownerAlerted = true;
  c.ownerAlertedAt = new Date().toISOString();
  c.ownerAlertedStage = c.stage || '';
  writeJson(CUSTOMERS_FILE, store.customers);
}

export function needsOwnerAlert(jid) {
  const c = store.customers[jid];
  if (!c) return false;
  if (c.ownerAlerted) return false;
  // We can only hand over a lead we can actually identify and act on.
  return Boolean(c.name && (c.product || c.businessType));
}

// A second alert is only worth sending when the customer moves to ready-to-buy,
// so the owner is not pinged again for the same lead.
export function shouldAlertOwner(jid) {
  const c = store.customers[jid];
  if (!c) return false;
  if (!c.ownerAlerted) return needsOwnerAlert(jid);
  return c.stage === 'ready_to_buy' && c.ownerAlertedStage !== 'ready_to_buy';
}

export function customerDigest(jid) {
  const c = store.customers[jid];
  if (!c) return '';
  const lines = [];
  if (c.name) lines.push(`Name: ${c.name}`);
  if (c.businessName) lines.push(`Business: ${c.businessName}`);
  if (c.businessType) lines.push(`Business type: ${c.businessType}`);
  if (c.city) lines.push(`City: ${c.city}`);
  if (c.product) lines.push(`Interested in: ${c.product}`);
  if (c.budget) lines.push(`Budget: ${c.budget}`);
  if (c.timeline) lines.push(`Timeline: ${c.timeline}`);
  if (c.email) lines.push(`Email: ${c.email}`);
  if (c.stage) lines.push(`Stage: ${c.stage}`);
  if (c.summary) lines.push(`Notes: ${c.summary}`);
  if (!lines.length) return '';
  const tail = c.ownerAlerted
    ? 'You have already passed this customer to Arslan. Do not promise a second handover; if they ask, say Arslan will message them shortly.'
    : 'You have not passed this customer to Arslan yet. Once you have their name and what they need, hand them over.';
  return `What you already know about this customer (do not ask again):\n${lines.join('\n')}\n${tail}`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function saveConfig() {
  writeJson(CONFIG_FILE, store.config);
}

export function getHistory(jid) {
  return store.history[jid] || [];
}

export function appendHistory(jid, role, content) {
  const list = store.history[jid] || (store.history[jid] = []);
  list.push({ role, content });
  while (list.length > MAX_HISTORY) list.shift();
  writeJson(HISTORY_FILE, store.history);
}

export function clearHistory(jid) {
  if (jid) delete store.history[jid];
  else store.history = {};
  writeJson(HISTORY_FILE, store.history);
}

const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
store.leads = readJson(LEADS_FILE, []);

export function saveLead(lead) {
  const entry = { ts: new Date().toISOString(), ...lead };
  store.leads.push(entry);
  writeJson(LEADS_FILE, store.leads);
  return entry;
}

export function log(level, message, extra) {
  const entry = { ts: new Date().toISOString(), level, message, ...(extra ? { extra } : {}) };
  store.logs.push(entry);
  while (store.logs.length > MAX_LOG) store.logs.shift();
  const line = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line, extra ?? '');
  else console.log(line, extra ?? '');
  return entry;
}
