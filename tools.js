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
      name: 'web_search',
      description:
        'Look up factual or encyclopedic information on the web. Use it when the user asks about a person, place, product, or topic you are unsure about.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'current_time',
      description: 'Get the current date and time.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export async function runTool(name, args) {
  if (name === 'web_search') return webSearch(args?.query || '');
  if (name === 'current_time') return new Date().toString();
  return `Unknown tool: ${name}`;
}
