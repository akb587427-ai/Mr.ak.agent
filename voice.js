// Turns WhatsApp voice notes into text and text back into voice notes.
//
// WhatsApp voice notes are OGG/Opus. Gemini can read that container directly, and its
// TTS models answer with raw 24 kHz PCM, which ffmpeg re-wraps as OGG/Opus so WhatsApp
// plays it as a real voice note. Nothing here needs a paid speech service.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { store, log } from './store.js';
import { splitKeys } from './llm.js';

const execFileAsync = promisify(execFile);

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Gemini's free tier counts speech quota per model per day, so a single exhausted
// model would silence the agent. Rotating across the speech models keeps the voice
// working, the same way the chat models are rotated in llm.js.
const TTS_MODELS = [
  process.env.TTS_MODEL,
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
].filter(Boolean);
// Curated Gemini prebuilt voices. "Charon" is a deep male voice and is the default so
// the assistant sounds like a male representative out of the box.
export const VOICES = [
  { id: 'Charon', label: 'Charon — male, deep and calm' },
  { id: 'Puck', label: 'Puck — male, upbeat' },
  { id: 'Orus', label: 'Orus — male, firm' },
  { id: 'Iapetus', label: 'Iapetus — male, clear' },
  { id: 'Fenrir', label: 'Fenrir — male, strong' },
  { id: 'Kore', label: 'Kore — female, neutral' },
  { id: 'Aoede', label: 'Aoede — female, light' },
  { id: 'Leda', label: 'Leda — female, youthful' },
  { id: 'Zephyr', label: 'Zephyr — female, bright' },
];
const DEFAULT_VOICE = 'Charon';

function selectedVoice() {
  const v = store.config.ttsVoice || process.env.TTS_VOICE || DEFAULT_VOICE;
  return VOICES.some((x) => x.id === v) ? v : DEFAULT_VOICE;
}
// WhatsApp itself caps a voice note at 16 minutes; staying well under keeps replies
// quick and the upload small.
const MAX_TTS_CHARS = 1200;

export function voiceReady() {
  return splitKeys(store.config.apiKey).length > 0;
}

function firstKey() {
  return splitKeys(store.config.apiKey)[0] || '';
}

function isGemini() {
  const c = store.config;
  return c.provider === 'gemini' || /generativelanguage\.googleapis\.com/.test(c.baseUrl || '');
}

async function run(cmd, args, timeout = 60000) {
  return execFileAsync(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 });
}

// ffmpeg works on files, so media is parked in a private temp dir and always cleaned up.
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function geminiGenerate(model, body, key) {
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error(`Gemini ${res.status}: ${text}`);
    // A 429 on one key is normal on the free tier; the caller rotates to the next.
    err.rateLimited = res.status === 429;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Speech calls share the same pool of keys as the chat model. Walking the keys means
// one exhausted free-tier key no longer silences the agent's voice.
async function withKeys(fn) {
  const keys = splitKeys(store.config.apiKey);
  if (!keys.length) throw new Error('No API key configured');
  let lastError = null;
  for (const key of keys) {
    try {
      return await fn(key);
    } catch (e) {
      lastError = e;
      if (e.status === 429 || e.rateLimited) {
        log('warn', 'Voice key rate limited, trying the next key');
        continue;
      }
      // A 400 usually means the model rejected this voice or payload; rotating will
      // not help, so fail fast.
      throw e;
    }
  }
  throw lastError || new Error('All API keys are rate limited right now.');
}

function joinText(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

// --- speech to text ---------------------------------------------------------

// Chat models that accept audio input, tried in order. The free tier returns 503
// ("high demand") on any single model fairly often, so relying on one model made the
// agent claim it could not understand a voice note. Rotating across them, and
// retrying, keeps transcription working.
const STT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-flash-lite-latest',
];
const STT_PROMPT =
  'Transcribe this WhatsApp voice message exactly as spoken. The speaker may use Urdu, ' +
  'Roman Urdu, English or a mix. Write the transcription in the same language and script ' +
  'the speaker used, keeping Urdu words in Roman letters when they are spoken that way. ' +
  'Reply with only the transcription, no commentary.';

async function transcribeGemini(buffer, mime, key) {
  let audio = buffer;
  let mimeType = mime || 'audio/ogg';
  // Gemini reads OGG/Opus directly; anything else is normalised first.
  if (!/ogg/i.test(mimeType)) {
    audio = await withTempDir(async (dir) => {
      const inp = path.join(dir, 'in');
      const out = path.join(dir, 'out.ogg');
      fs.writeFileSync(inp, buffer);
      await run('ffmpeg', ['-y', '-i', inp, '-c:a', 'libopus', '-b:a', '32k', out]);
      return fs.readFileSync(out);
    });
    mimeType = 'audio/ogg';
  }
  const body = {
    contents: [
      { parts: [{ text: STT_PROMPT }, { inlineData: { mimeType, data: audio.toString('base64') } }] },
    ],
  };

  let lastError = null;
  for (let round = 0; round < 2; round++) {
    for (const model of STT_MODELS) {
      try {
        const text = joinText(await geminiGenerate(model, body, key));
        if (text) return text;
        lastError = new Error('Transcription came back empty');
      } catch (e) {
        lastError = e;
        // Only a transient fault is worth another model or another round.
        if (e.status === 503 || e.status === 429) continue;
        throw e;
      }
    }
    // Every model is busy. Wait briefly before the second pass instead of answering
    // the customer with a failure.
    if (round === 0) await new Promise((r) => setTimeout(r, 2500));
  }
  throw lastError || new Error('Could not transcribe the voice note');
}

async function transcribeOpenAI(buffer, mime, key) {
  const base = (store.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), 'voice.ogg');
  form.append('model', process.env.STT_MODEL || 'whisper-1');
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).text?.trim() || '';
}

export async function transcribeAudio(buffer, mime) {
  if (!splitKeys(store.config.apiKey).length) throw new Error('No API key configured');
  return isGemini() ? withKeys((key) => transcribeGemini(buffer, mime, key)) : transcribeOpenAI(buffer, mime, firstKey());
}

// --- text to speech ---------------------------------------------------------

// Gemini TTS returns headerless signed 16-bit PCM; wrap it as OGG/Opus so WhatsApp
// shows a playable voice note rather than an unknown attachment.
async function pcmToVoiceNote(pcm, rate) {
  return withTempDir(async (dir) => {
    const inp = path.join(dir, 'in.pcm');
    const out = path.join(dir, 'out.ogg');
    fs.writeFileSync(inp, pcm);
    await run('ffmpeg', [
      '-y', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', inp,
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', out,
    ]);
    return fs.readFileSync(out);
  });
}

async function synthesizeGemini(text, key) {
  let lastError = null;
  for (const model of TTS_MODELS) {
    try {
      const data = await geminiGenerate(model, {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice() } } },
        },
      }, key);
      const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
      if (!part) throw new Error('TTS returned no audio');
      const rate = Number((/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1] || 24000);
      if (model !== TTS_MODELS[0]) log('info', `Voice generated with ${model}`);
      return pcmToVoiceNote(Buffer.from(part.inlineData.data, 'base64'), rate);
    } catch (e) {
      lastError = e;
      // Only a quota or overload failure is worth another model; a bad voice name or
      // malformed request would fail the same way everywhere.
      if (e.status === 429 || e.status === 503) {
        log('warn', `TTS model ${model} unavailable (${e.status}), trying the next`);
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error('All speech models are unavailable right now.');
}

async function synthesizeOpenAI(text, key) {
  const base = (store.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  // "onyx" is the deep male voice on OpenAI's speech endpoint.
  const voice = process.env.TTS_OPENAI_VOICE || 'onyx';
  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TTS_OPENAI_MODEL || 'tts-1', voice, input: text, response_format: 'opus' }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function synthesizeSpeech(text) {
  if (!splitKeys(store.config.apiKey).length) throw new Error('No API key configured');
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TTS_CHARS);
  if (!clean) throw new Error('Nothing to speak');
  return isGemini() ? withKeys((key) => synthesizeGemini(clean, key)) : synthesizeOpenAI(clean, firstKey());
}

export function ffmpegAvailable() {
  try {
    return fs.existsSync('/usr/bin/ffmpeg') || fs.existsSync('/usr/local/bin/ffmpeg');
  } catch {
    return false;
  }
}
