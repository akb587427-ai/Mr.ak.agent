import fs from 'fs';
import path from 'path';
import { DEFAULT_KNOWLEDGE } from './knowledge.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_LOG = 300;
const MAX_HISTORY = 24;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function defaultConfig() {
  return {
    provider: 'groq',
    apiKey: '',
    model: '',
    baseUrl: '',
    systemPrompt:
      'You are the official WhatsApp sales and support assistant for TECH ARSLAN SOFTWARE SOLUTIONS. Be warm, professional and brief. Use plain text only, no markdown.',
    knowledge: DEFAULT_KNOWLEDGE,
    enabled: true,
    respondToGroups: false,
    triggerPrefix: '',
  };
}

export const store = {
  config: { ...defaultConfig(), ...readJson(CONFIG_FILE, {}) },
  history: readJson(HISTORY_FILE, {}),
  logs: [],
};

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
