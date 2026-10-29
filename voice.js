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
import { splitKeys, chatCompletion, resolveEndpoints } from './llm.js';

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
// The "edge:" entries are Microsoft Edge's read-aloud voices, reached through the free
// edge-tts utility. They need no API key and no quota, which keeps the agent speaking
// even when the Gemini key is missing or exhausted.
export const VOICES = [
  { id: 'Charon', label: 'Charon — male, deep and calm (Gemini)' },
  { id: 'Puck', label: 'Puck — male, upbeat (Gemini)' },
  { id: 'Orus', label: 'Orus — male, firm (Gemini)' },
  { id: 'Iapetus', label: 'Iapetus — male, clear (Gemini)' },
  { id: 'Fenrir', label: 'Fenrir — male, strong (Gemini)' },
  { id: 'Kore', label: 'Kore — female, neutral (Gemini)' },
  { id: 'Aoede', label: 'Aoede — female, light (Gemini)' },
  { id: 'Leda', label: 'Leda — female, youthful (Gemini)' },
  { id: 'Zephyr', label: 'Zephyr — female, bright (Gemini)' },
  { id: 'edge:ur-PK-AsadNeural', label: 'Asad — male, Urdu (free, unlimited)' },
  { id: 'edge:hi-IN-MadhurNeural', label: 'Madhur — male, Hindi (free, unlimited)' },
  { id: 'edge:en-US-GuyNeural', label: 'Guy — male, English (free, unlimited)' },
  { id: 'edge:ur-PK-UzmaNeural', label: 'Uzma — female, Urdu (free, unlimited)' },
  { id: 'groq:canopylabs/orpheus-v1-english:tara', label: 'Tara — female, English (Groq, free)' },
  { id: 'groq:canopylabs/orpheus-v1-english:daniel', label: 'Daniel — male, English (Groq, free)' },
  { id: 'groq:canopylabs/orpheus-arabic-saudi:abdullah', label: 'Abdullah — male, Arabic (Groq, free)' },
  { id: 'groq:canopylabs/orpheus-arabic-saudi:aisha', label: 'Aisha — female, Arabic (Groq, free)' },
];
// The default is the free, keyless Urdu male voice: it costs nothing, has no quota,
// and keeps working even when no API key is configured. Gemini voices remain available
// in the picker for anyone who prefers them.
const DEFAULT_VOICE = 'edge:ur-PK-AsadNeural';
// Used when the chosen Gemini voice cannot be produced — a missing or exhausted key
// should still leave the customer with a male voice reply, not silence.
const FALLBACK_EDGE_VOICE = 'ur-PK-AsadNeural';

function selectedVoice() {
  const v = store.config.ttsVoice || process.env.TTS_VOICE || DEFAULT_VOICE;
  return VOICES.some((x) => x.id === v) ? v : DEFAULT_VOICE;
}
// WhatsApp itself caps a voice note at 16 minutes; staying well under keeps replies
// quick and the upload small.
const MAX_TTS_CHARS = 3000;

// Replies are written for a screen, so they carry markdown, bullet characters and
// emoji. Spoken aloud those become "star star" and stray symbols, which is a large part
// of why the voice sounded wrong. Strip the formatting and keep the words.
function speechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cached because state() is synchronous; refreshed at startup and after config changes.
let edgeTtsUsable = true;

export function voiceReady() {
  // A reply voice is always possible: the free Edge voice needs no key and is used
  // whenever a Gemini voice is unavailable. So voice is ready as long as either a key
  // exists or edge-tts is installed.
  return splitKeys(store.config.apiKey).length > 0 || edgeTtsUsable;
}

// Transcription needs a real speech-to-text service; there is no keyless option, so the
// caller can tell the customer to type instead of pretending the note was understood.
export function sttReady() {
  return splitKeys(store.config.apiKey).length > 0;
}

export async function edgeTtsAvailable() {
  try {
    await run('python3', ['-c', 'import edge_tts'], 20000);
    edgeTtsUsable = true;
  } catch {
    edgeTtsUsable = false;
  }
  return edgeTtsUsable;
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

// WhatsApp plays a voice note as OGG/Opus, while Groq's speech endpoint returns WAV.
// Transcode so a Groq voice arrives as a playable voice note rather than a file.
async function wavToOgg(wav) {
  return withTempDir(async (dir) => {
    const inFile = path.join(dir, 'speech.wav');
    const outFile = path.join(dir, 'speech.ogg');
    fs.writeFileSync(inFile, wav);
    await run('ffmpeg', ['-y', '-i', inFile, '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', outFile]);
    return fs.readFileSync(outFile);
  });
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
  // Use the configured endpoint for this provider; defaulting to OpenAI's URL sent the
  // Groq key to the wrong service. resolveEndpoints already knows the right base URL.
  const [endpoint] = resolveEndpoints(store.config);
  const base = (endpoint?.baseUrl || store.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  // Groq hosts Whisper too, under its own model name; pointing "whisper-1" at Groq
  // would 404, so the model follows the provider.
  const provider = store.config.provider;
  const defaultModel = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), 'voice.ogg');
  form.append('model', process.env.STT_MODEL || defaultModel);
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

// Groq's Orpheus voices are the most natural of the free options, but the model has to
// be accepted once in the Groq console before it answers. When it has not been, the
// error is raised here and the caller falls back to the Edge voice.
async function synthesizeGroq(text, model, voice) {
  const key = splitKeys(store.config.apiKey)[0];
  if (!key) throw new Error('no API key configured');
  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, input: text, response_format: 'wav' }),
  });
  if (!res.ok) throw new Error(`Groq TTS ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return wavToOgg(Buffer.from(await res.arrayBuffer()));
}

// Cutting a reply mid-sentence is what made a long answer sound like it stopped halfway,
// so trim back to the last sentence that fits and only fall back to a hard cut when there
// is no sentence end to use.
function fitToLimit(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '), head.lastIndexOf('۔ '));
  return cut > limit * 0.5 ? head.slice(0, cut + 1).trim() : head.trim();
}

export async function synthesizeSpeech(text) {
  const clean = fitToLimit(speechText(text), MAX_TTS_CHARS);
  if (!clean) throw new Error('Nothing to speak');
  const voice = selectedVoice();

  // A keyless Edge voice, or a Groq voice that falls back to Edge when its terms have
  // not been accepted yet, so the customer still hears a reply.
  if (voice.startsWith('edge:')) {
    return synthesizeEdge(clean, voice.slice(5));
  }
  if (voice.startsWith('groq:')) {
    const [, model, name] = voice.split(':');
    try {
      return await synthesizeGroq(await toSpeakableScript(clean, model), model, name);
    } catch (e) {
      log('warn', `Groq voice failed (${String(e.message).slice(0, 120)}), using the free Edge voice`);
      return synthesizeEdge(clean, FALLBACK_EDGE_VOICE);
    }
  }
  if (!splitKeys(store.config.apiKey).length) {
    return synthesizeEdge(clean, FALLBACK_EDGE_VOICE);
  }
  try {
    return await (isGemini() ? withKeys((key) => synthesizeGemini(clean, key)) : synthesizeOpenAI(clean, firstKey()));
  } catch (e) {
    log('warn', `Gemini voice failed (${String(e.message).slice(0, 80)}), using the free Edge voice`);
    return synthesizeEdge(clean, FALLBACK_EDGE_VOICE);
  }
}

// edge-tts streams MP3; ffmpeg re-wraps it as the OGG/Opus container WhatsApp expects
// for a voice note. Free, keyless, and unaffected by any API quota.
async function synthesizeEdge(text, voice) {
  const speakable = await toSpeakableScript(text, voice);
  return withTempDir(async (dir) => {
    const mp3 = path.join(dir, 'speech.mp3');
    const ogg = path.join(dir, 'speech.ogg');
    // The service occasionally drops a request, so give it one more try before the
    // customer is left without a reply.
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await run('python3', ['-m', 'edge_tts', '--voice', voice, '--text', speakable, '--write-media', mp3], 60000);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (lastError) throw new Error(`Edge TTS failed: ${String(lastError.message).slice(0, 200)}`);
    await run('ffmpeg', ['-y', '-i', mp3, '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', ogg]);
    return fs.readFileSync(ogg);
  });
}

const URDU_RE = /[\u0600-\u06FF]/;
const DEVA_RE = /[\u0900-\u097F]/;

function targetScript(voice) {
  if (/^(ur|fa|ar)-/i.test(voice)) return { re: URDU_RE, script: 'Urdu in Arabic script, as written in Pakistan' };
  if (/^(hi|mr|ne)-/i.test(voice)) return { re: DEVA_RE, script: 'Devanagari script' };
  // The Groq Arabic model reads Arabic script, so it needs the same conversion as Urdu.
  if (/orpheus-arabic/i.test(voice)) return { re: URDU_RE, script: 'Urdu in Arabic script, as written in Pakistan' };
  return null;
}

// These voices read their own script, not Latin letters. Roman Urdu such as "pharmacy ka
// software 45000 rupay hai" came out as "फार्मसी का सौफ्ट्वर" — audible garbage, and the
// owner reported exactly that. Every word has to be converted, brand names included,
// because a single leftover Latin word is read in the wrong language and the rest of the
// sentence stops making sense.
const LATIN_RE = /[A-Za-z]/;

async function toSpeakableScript(text, voice) {
  const target = targetScript(voice);
  if (!target) return text;
  // Nothing to do when the text is already readable by this voice.
  if (target.re.test(text) && !LATIN_RE.test(text)) return text;
  if (!splitKeys(store.config.apiKey).length) return text;

  const instruction = (leftover) =>
    `Rewrite the user's text in ${target.script}, the way a Pakistani speaker would say ` +
    'it. Write every word in that script, including English and brand names, spelled ' +
    'out the way they sound in Pakistani speech. Digits such as prices may stay as ' +
    'digits. Reply with only the rewritten text and nothing else.' +
    (leftover ? ` These words are still in Latin letters and must be converted too: ${leftover}.` : '');

  let out = '';
  let source = text;
  let leftover = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const choice = await chatCompletion({
        endpoints: resolveEndpoints(store.config),
        messages: [
          { role: 'system', content: instruction(leftover) },
          { role: 'user', content: source },
        ],
        temperature: 0,
        // The default 600-token budget is not enough for a reasoning model, which spends
        // it on its thinking and returns no text at all.
        maxTokens: 2000,
      });
      out = (choice.content || '').trim();
    } catch (e) {
      log('warn', `Could not transliterate for speech: ${String(e.message).slice(0, 80)}`);
      break;
    }
    if (!out || !target.re.test(out)) break;
    leftover = (out.match(/[A-Za-z]+/g) || []).join(' ');
    if (!leftover) return out;
    // A word survived in Latin letters. Ask again, showing it what is still wrong.
    source = out;
    log('warn', `Speech text still had Latin words (${leftover.slice(0, 60)}); asking for a full conversion`);
  }

  // A partial conversion is still better than Roman text read aloud by an Urdu voice.
  if (out && target.re.test(out)) return out;
  log('warn', `Transliteration for speech returned no ${target.script}; speaking the original text`);
  return text;
}

export function ffmpegAvailable() {
  try {
    return fs.existsSync('/usr/bin/ffmpeg') || fs.existsSync('/usr/local/bin/ffmpeg');
  } catch {
    return false;
  }
}
