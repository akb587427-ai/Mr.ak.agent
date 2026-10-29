// Handles incoming WhatsApp voice/video calls.
//
// Baileys can see a call and reject it, but it has no audio transport: there is no
// acceptCall, no SRTP/RTP stack and no media relay in the library, so a real two-way
// conversation on the WhatsApp call channel is not possible from a linked device.
// What is possible, and what this does, is answer the *intent* of the call: the agent
// rejects the ringing call and immediately opens the conversation with a spoken voice
// note, then keeps talking to the customer over voice notes and text. The owner still
// gets a DM so a real phone call can be returned if the customer wants one.
import { log, getHistory, appendHistory } from './store.js';
import { store } from './store.js';
import { synthesizeSpeech, voiceReady, ffmpegAvailable } from './voice.js';

export const callStats = { total: 0, lastAt: null, lastFrom: null, lastMode: null };

export function callsConfig() {
  const c = store.config.calls || {};
  return {
    // off   - ignore calls completely
    // text  - reject and send a text follow-up
    // voice - reject and send a spoken voice note (needs ffmpeg + an LLM key)
    mode: c.mode || 'voice',
    notifyOwner: c.notifyOwner !== false,
    greeting: (c.greeting || '').trim(),
  };
}

export function voiceRepliesEnabled() {
  return store.config.voiceReplies !== false;
}

function defaultGreeting(customer) {
  return [
    'Assalam o Alaikum! Aap ka call humein mil gaya.',
    'Main TECH ARSLAN SOFTWARE SOLUTIONS ka AI assistant hoon, is liye call par direct baat nahi ho sakti.',
    'Lekin koi masla nahi — yahan isi chat par batayein, main foran jawab deta hoon.',
    'Aap ko business software chahiye ya koi online service?',
  ].join(' ');
}

export async function handleCallEvent(sock, call, { notifyOwner } = {}) {
  const cfg = callsConfig();
  if (cfg.mode === 'off') return;
  // "offer" is the ringing state. Everything else (accept/reject/timeout) is the
  // tail of a call we already handled or one the caller abandoned.
  if (call.status !== 'offer') return;
  if (call.isGroup) return;

  const from = call.from;
  const callerPn = call.callerPn || (from && !from.endsWith('@lid') ? from.split('@')[0] : '');
  const phone = String(callerPn || '').replace(/\D/g, '');

  callStats.total += 1;
  callStats.lastAt = new Date().toISOString();
  callStats.lastFrom = phone || from;
  callStats.lastMode = cfg.mode;

  log('info', `Incoming ${call.isVideo ? 'video ' : ''}call from ${phone || from} — cannot be answered on a linked device, following up on chat`);

  // Always reject, otherwise the caller keeps ringing a device that will never pick up.
  try {
    await sock.rejectCall(call.id, from);
  } catch (e) {
    log('warn', 'Could not reject call', e.message);
  }

  const text = cfg.greeting || defaultGreeting();
  const canSpeak = cfg.mode === 'voice' && voiceReady() && ffmpegAvailable();

  try {
    if (canSpeak) {
      const audio = await synthesizeSpeech(text);
      await sock.sendMessage(from, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      log('info', `Sent spoken call follow-up to ${phone || from}`);
    } else {
      await sock.sendMessage(from, { text });
      log('info', `Sent text call follow-up to ${phone || from}`);
    }
  } catch (e) {
    log('error', 'Call follow-up failed', e.message);
    await sock.sendMessage(from, { text }).catch(() => {});
  }

  // Remember the attempt so the conversation reads naturally on the next message.
  appendHistory(from, 'assistant', text);
  if (getHistory(from).length === 0) appendHistory(from, 'user', '[customer tried to call]');

  if (cfg.notifyOwner && typeof notifyOwner === 'function') {
    await notifyOwner({
      customer: { jid: from, phone },
      reason: `Customer tried to ${call.isVideo ? 'video ' : ''}call this number. The call cannot be answered on a linked WhatsApp device — the agent replied with a ${canSpeak ? 'voice note' : 'message'} and is handling the chat. Call back on ${phone || 'their number'} if needed.`,
    }).catch(() => {});
  }
}
