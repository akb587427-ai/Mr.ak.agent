import { generateReply } from './llm.js';
import { toolDefinitions, runTool, handoffToOwner } from './tools.js';
import {
  getHistory,
  appendHistory,
  customerDigest,
  getCustomer,
  updateCustomer,
  shouldAlertOwner,
  log,
  store,
} from './store.js';

const MAX_TOOL_ROUNDS = 4;

// Pull the customer's details straight out of their own words, with no API call.
// This used to be a second LLM request per message, which alone could exhaust a
// free tier's per-minute budget. Only facts the customer actually typed are taken.
const CITY_WORDS = [
  'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan', 'gujranwala',
  'peshawar', 'quetta', 'hyderabad', 'sialkot', 'bahawalpur', 'sargodha', 'sukkur',
  'larkana', 'gujrat', 'sahiwal', 'jhelum', 'abbottabad', 'mardan', 'kasur', 'okara',
  'sheikhupura', 'rahim yar khan', 'dera ghazi khan', 'mirpur', 'muzaffarabad',
];
const PRODUCT_WORDS = [
  ['Pharmacy POS', /pharmacy|medical store|chemist|dawa|pharma/i],
  ['Laboratory Management', /lab(?:oratory)?\b|diagnostic|pathology/i],
  ['Hospital Management', /hospital|clinic|patient management/i],
  ['School Management', /school|college|academy|madrasa|education/i],
  ['Restaurant POS', /restaurant|hotel|dhaba|cafe|food point|bakery/i],
  ['Retail POS', /retail|general store|kiryana|super ?market|mart|shop pos/i],
  ['Inventory Management', /inventory|stock management|warehouse/i],
  ['TikTok followers', /tiktok (?:followers|likes|views)/i],
  ['TikTok monetization', /tiktok monetiz/i],
  ['YouTube subscribers', /youtube (?:subscribers|views|watch hours)/i],
  ['YouTube monetization', /youtube monetiz/i],
  ['Instagram followers', /instagram/i],
  ['Facebook page growth', /facebook (?:page|followers|likes)/i],
  ['Google AdSense approval', /adsense/i],
  ['Google Ads account', /google ads\b/i],
  ['Meta Ads account', /meta ads|facebook ads|instagram ads/i],
  ['TikTok Ads account', /tiktok ads/i],
  ['RDP server', /\brdp\b|remote desktop/i],
  ['VPS server', /\bvps\b/i],
  ['Dedicated server', /dedicated server/i],
  ['Cloud setup', /google cloud|\baws\b|azure/i],
  ['International number', /international number|virtual number|disposable number|sms number/i],
  ['WhatsApp number', /whatsapp number/i],
  ['PayPal account', /paypal/i],
  ['Payoneer account', /payoneer/i],
  ['Wise account', /\bwise\b/i],
  ['Stripe account', /stripe/i],
  ['Verified accounts', /verified account|aged account|binance account|account verification/i],
  ['Domain and hosting', /domain|hosting|\bssl\b|business email/i],
  ['Premium tools', /premium tool|subscription|license key/i],
];
const STAGE_WORDS = [
  ['ready_to_buy', /\b(?:order|book) (?:it|kar|kardo|confirm)|confirm kar|lena chahta|lena chahti|buy kar|purchase kar|ready (?:to buy|hoon)|chalein shuru|start kar dein\b/i],
  ['demo_pending', /demo (?:chahiye|karwa|karwao|dein|dijiye|book|schedule|kar dein)|free demo/i],
  ['not_interested', /(?:not interested|interest nahi|nahi chahiye|abhi nahi chahiye|too expensive|bohat mehnga|rehne dein)/i],
  ['negotiating', /(?:discount|kam kar|thora kam|price kam|mehnga|expensive|budget kam)/i],
  ['interested', /(?:chahiye|chahta|chahti|need|required|interested|kitne ka|price|rate|quote)/i],
];

// Returns only the fields it is confident about, so a wrong guess never overwrites
// something the customer already told us.
export function extractLocal(text) {
  const out = {};
  const t = String(text || '');

  const name = t.match(/\b(?:my name is|mera naam|mera nam|naam)\s+([A-Za-z][A-Za-z .'-]{1,30}?)(?=\s+(?:hai|hun|hoon|he|is|from|se)\b|[,.!?]|$)/i);
  if (name) {
    const cleaned = name[1].trim().replace(/\s+/g, ' ');
    if (cleaned.length >= 2) out.name = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const lower = t.toLowerCase();
  const city = CITY_WORDS.find((c) => lower.includes(c));
  if (city) out.city = city.replace(/\b\w/g, (c) => c.toUpperCase());

  const product = PRODUCT_WORDS.find(([, re]) => re.test(t));
  if (product) out.product = product[0];

  const stage = STAGE_WORDS.find(([, re]) => re.test(t));
  if (stage) out.stage = stage[0];

  const budget = t.match(/(?:budget|bajet|bujet)\D{0,12}(\d[\d,]{2,})/i) || t.match(/(\d[\d,]{4,})\s*(?:budget|tak|mein|me)\b/i);
  if (budget) out.budget = budget[1].replace(/,/g, '');

  const email = t.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (email) out.email = email[0];

  const business = t.match(/\b(?:my business is|business ka naam|business name|business)\s+([A-Za-z][A-Za-z0-9 .&'-]{2,40}?)(?=\s+(?:hai|he|is|se|from)\b|[,.!?]|$)/i);
  if (business) out.businessName = business[1].trim();

  return out;
}

// Merge local extraction into the customer record without clobbering known values.
function applyLocalExtraction(jid, text) {
  const found = extractLocal(text);
  if (!Object.keys(found).length) return found;
  const c = getCustomer(jid) || {};
  const patch = {};
  for (const [k, v] of Object.entries(found)) {
    if (v && !c[k]) patch[k] = v;
  }
  if (!c.summary) {
    const bits = [found.name && `Name ${found.name}`, found.city && found.city, found.product]
      .filter(Boolean)
      .join(', ');
    if (bits) patch.summary = bits;
  }
  if (Object.keys(patch).length) updateCustomer(jid, patch);
  return found;
}

export async function respond(jid, userText, ctx = {}) {
  const config = store.config;
  // The chat id is not always a phone number (WhatsApp hides it behind "@lid").
  // Record the real number whenever the caller knows it.
  if (ctx.phone) updateCustomer(jid, { phone: ctx.phone });
  const digest = customerDigest(jid);
  const system = [config.systemPrompt, config.knowledge, digest].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: system },
    ...getHistory(jid),
    { role: 'user', content: userText },
  ];

  const isNew = !getCustomer(jid);

  let reply = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const choice = await generateReply(config, messages, toolDefinitions);
    if (choice.tool_calls?.length) {
      messages.push(choice);
      for (const call of choice.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        let result;
        try {
          result = await runTool(call.function.name, args, { jid, notifyOwner: ctx.notifyOwner });
        } catch (e) {
          result = `Tool error: ${e.message}`;
        }
        log('info', `Tool ${call.function.name} -> ${String(result).slice(0, 120)}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
      // The model usually writes the customer-facing text in the same turn as the
      // tool call. Reusing it saves a whole round trip, which matters on free tiers
      // that only allow a couple of requests per minute.
      const inline = (choice.content || '').trim();
      if (inline) {
        reply = inline;
        break;
      }
      continue;
    }
    reply = (choice.content || '').trim();
    break;
  }

  if (!reply) reply = 'Sorry, I could not produce a reply right now. Please try again.';
  appendHistory(jid, 'user', userText);
  appendHistory(jid, 'assistant', reply);

  // Pull whatever the customer revealed into their profile. This is done locally,
  // with no API call, so it never competes for the same per-minute token budget as
  // the reply itself.
  applyLocalExtraction(jid, userText);

  if (shouldAlertOwner(jid)) {
    const c = getCustomer(jid);
    log('info', `Auto-handing over ${c.name} to owner`);
    handoffToOwner(c, 'Customer shared their details and interest.', ctx.notifyOwner);
  }

  return { reply, isNew };
}
