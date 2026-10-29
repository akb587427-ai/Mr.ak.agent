import { saveLead, updateCustomer, markOwnerAlerted, log, store } from './store.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function wikiSearch(query, max) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=' +
    max +
    '&srsearch=' +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.query?.search || []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: stripTags(r.snippet || ''),
  }));
}

async function ddgInstant(query) {
  const url =
    'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const data = await res.json();
  const out = [];
  if (data.AbstractText) {
    out.push({ title: data.Heading || 'Summary', url: data.AbstractURL || '', snippet: data.AbstractText });
  }
  for (const t of data.RelatedTopics || []) {
    if (t.Text && t.FirstURL && out.length < 5) out.push({ title: t.Text, url: t.FirstURL, snippet: '' });
    if (t.Topics) {
      for (const s of t.Topics) {
        if (s.Text && s.FirstURL && out.length < 5) out.push({ title: s.Text, url: s.FirstURL, snippet: '' });
      }
    }
  }
  return out;
}

export async function webSearch(query, max = 5) {
  const [wiki, instant] = await Promise.all([
    wikiSearch(query, max).catch(() => []),
    ddgInstant(query).catch(() => []),
  ]);
  const seen = new Set();
  const merged = [];
  for (const r of [...(instant || []), ...wiki]) {
    const key = r.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
    if (merged.length >= max) break;
  }
  if (!merged.length) return `No results found for "${query}".`;
  return merged
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}${r.snippet ? '\n' + r.snippet : ''}`.trim())
    .join('\n\n');
}

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'remember_customer',
      description:
        'Save what you learn about this customer: their name, city, the product or online service they want, and how far along the deal is. Call it whenever you learn something new.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Customer name.' },
          city: { type: 'string', description: 'Their city.' },
          product: {
            type: 'string',
            description: 'Which TECH ARSLAN product or online service they want.',
          },
          budget: { type: 'string', description: 'Budget they mention.' },
          stage: {
            type: 'string',
            description: 'Deal stage: new, interested, demo_pending, negotiating, ready_to_buy.',
          },
          summary: { type: 'string', description: 'One line on what they need.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alert_owner',
      description:
        'Alert the owner (Arslan) on WhatsApp about a customer who is ready for a human. Use it once you have their name and what they need, and when they agree to a demo or to buy.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the owner should follow up.' },
        },
        required: ['reason'],
      },
    },
  },
];

export async function runTool(name, args, ctx = {}) {
  const { jid = '', notifyOwner } = ctx;
  if (name === 'web_search') return webSearch(args?.query || '');
  if (name === 'current_time') return new Date().toString();

  if (name === 'remember_customer') {
    const c = updateCustomer(jid, {
      name: args?.name,
      businessName: args?.business_name,
      businessType: args?.business_type,
      city: args?.city,
      product: args?.product,
      email: args?.email,
      budget: args?.budget,
      timeline: args?.timeline,
      stage: args?.stage,
      summary: args?.summary,
    });
    log('info', `Remembered customer ${c.name || jid}${c.product ? ` (${c.product})` : ''}`);
    return 'Saved. Use what you know about this customer and do not ask for those details again.';
  }

  if (name === 'alert_owner' || name === 'save_lead') {
    const c = updateCustomer(jid, {
      name: args?.name,
      businessName: args?.business_name,
      businessType: args?.business_type,
      city: args?.city,
      product: args?.product,
      notes: args?.notes,
      stage: args?.stage || (name === 'save_lead' ? 'interested' : undefined),
    });
    handoffToOwner(c, args?.reason || args?.notes || '', notifyOwner);
    return 'Done. The owner has been alerted and will contact the customer. Tell the customer that Arslan from TECH ARSLAN will personally get in touch on this WhatsApp number shortly.';
  }

  return `Unknown tool: ${name}`;
}

// Record the lead and DM the owner. Called from the tool and also from the agent
// as a safety net, so it dedupes: one alert per lead, plus one more if the
// customer later becomes ready to buy.
export function handoffToOwner(customer, reason, notifyOwner) {
  const c = customer || {};
  const jid = c.jid || '';
  const existing = jid ? store.customers[jid] : null;
  const stage = c.stage || existing?.stage || '';
  const readyNow = stage === 'ready_to_buy';
  const alreadyAlerted = Boolean(existing?.ownerAlerted);
  const alertedReady = existing?.ownerAlertedStage === 'ready_to_buy';
  if (alreadyAlerted && !(readyNow && !alertedReady)) return;

  saveLead({
    name: c.name || '',
    businessName: c.businessName || '',
    city: c.city || '',
    product: c.product || '',
    businessType: c.businessType || '',
    notes: c.notes || c.summary || '',
    whatsapp: jid,
    reason: reason || '',
  });
  log('info', `Lead for owner: ${c.name || jid}${c.product ? ` — ${c.product}` : ''}`);
  if (jid) markOwnerAlerted(jid);
  if (typeof notifyOwner === 'function') {
    notifyOwner({ customer: { ...c, stage }, reason: reason || '' }).catch((e) =>
      log('error', 'Owner alert failed', e.message),
    );
  }
}
