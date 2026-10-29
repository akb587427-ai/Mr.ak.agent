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
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'Kore';
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
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function joinText(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

// --- speech to text ---------------------------------------------------------

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
  const model = store.config.model || 'gemini-2.5-flash';
  const data = await geminiGenerate(model, {
    contents: [
      {
        parts: [
          { text: 'Transcribe this WhatsApp voice message. Reply with only the transcription, no commentary.' },
          { inlineData: { mimeType, data: audio.toString('base64') } },
        ],
      },
    ],
  }, key);
  return joinText(data);
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
  const key = firstKey();
  if (!key) throw new Error('No API key configured');
  return isGemini() ? transcribeGemini(buffer, mime, key) : transcribeOpenAI(buffer, mime, key);
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
  const data = await geminiGenerate(TTS_MODEL, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
    },
  }, key);
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error('TTS returned no audio');
  const rate = Number((/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1] || 24000);
  return pcmToVoiceNote(Buffer.from(part.inlineData.data, 'base64'), rate);
}

async function synthesizeOpenAI(text, key) {
  const base = (store.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TTS_OPENAI_MODEL || 'tts-1', voice: 'alloy', input: text, response_format: 'opus' }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function synthesizeSpeech(text) {
  const key = firstKey();
  if (!key) throw new Error('No API key configured');
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TTS_CHARS);
  if (!clean) throw new Error('Nothing to speak');
  return isGemini() ? synthesizeGemini(clean, key) : synthesizeOpenAI(clean, key);
}

export function ffmpegAvailable() {
  try {
    return fs.existsSync('/usr/bin/ffmpeg') || fs.existsSync('/usr/local/bin/ffmpeg');
  } catch {
    return false;
  }
}
