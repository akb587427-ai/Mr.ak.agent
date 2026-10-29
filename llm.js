export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (free tier, generous limits)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  groq: {
    label: 'Groq (fast, free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    label: 'OpenRouter (many models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  custom: {
    label: 'Custom (OpenAI compatible)',
    baseUrl: '',
    defaultModel: '',
    keyUrl: '',
  },
};

const KEY_PREFIXES = [
  { match: /^gsk_/, provider: 'groq' },
  { match: /^AIza/, provider: 'gemini' },
  { match: /^sk-or-/, provider: 'openrouter' },
  { match: /^sk-proj-/, provider: 'openai' },
  { match: /^sk-/, provider: 'openai' },
];

export function detectProviderFromKey(apiKey) {
  for (const { match, provider } of KEY_PREFIXES) {
    if (match.test(apiKey)) return provider;
  }
  return null;
}

// The API key box accepts several keys at once, separated by commas, spaces or new
// lines. Free tiers each allow only a small number of tokens per minute, so two or
// three free keys together give a comfortable budget. The provider of each key is
// recognised from its prefix, so a Groq key and a Gemini key can sit side by side.
export function splitKeys(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function presetFor(provider) {
  return PROVIDERS[provider] || PROVIDERS.custom;
}

// One entry per usable key, ordered so the key the user picked in the dropdown is
// tried first. Any key whose provider is recognised on its own gets that provider's
// endpoint, even if the dropdown is on something else.
export function resolveEndpoints(config) {
  const keys = splitKeys(config.apiKey);
  if (!keys.length) {
    throw new Error('No LLM API key set. Open AI settings in the web app and add one.');
  }

  const chosen = config.provider || 'custom';
  const chosenPreset = presetFor(chosen);
  const configuredBase = (config.baseUrl || '').replace(/\/+$/, '');
  const endpoints = [];

  for (const key of keys) {
    const detected = detectProviderFromKey(key);
    let provider = detected || chosen;
    let preset = presetFor(provider);
    let baseUrl = (preset.baseUrl || '').replace(/\/+$/, '');
    // The model the user typed belongs to the provider they picked. A key from a
    // different provider gets that provider's own default, since model names do not
    // carry across (Groq's "openai/gpt-oss-120b" is meaningless to Gemini).
    let model = provider === chosen ? config.model || preset.defaultModel : preset.defaultModel;

    // A custom endpoint applies to the single key the user configured by hand.
    if (keys.length === 1 && configuredBase) {
      provider = chosen;
      preset = chosenPreset;
      baseUrl = configuredBase;
      model = config.model || chosenPreset.defaultModel;
    } else if (!baseUrl) {
      // Nothing recognisable and no preset URL: fall back to what the user typed.
      provider = chosen;
      preset = chosenPreset;
      baseUrl = configuredBase || (chosenPreset.baseUrl || '').replace(/\/+$/, '');
      model = config.model || chosenPreset.defaultModel;
    }

    if (!baseUrl) continue;
    endpoints.push({
      id: `${provider}:${baseUrl}:${key.slice(-6)}`,
      apiKey: key,
      baseUrl,
      model,
      provider,
      label: `${preset.label || provider} (…${key.slice(-4)})`,
    });
  }

  if (!endpoints.length) {
    throw new Error('No usable LLM endpoint. Pick a provider or set the base URL in AI settings.');
  }

  // Keep the user's chosen provider in front, the rest as spare capacity.
  endpoints.sort((a, b) => (a.provider === chosen ? -1 : 0) - (b.provider === chosen ? -1 : 0));
  return endpoints;
}

// Kept for the settings screen, which shows one endpoint at a time.
export function resolveLlm(config) {
  const [first] = resolveEndpoints(config);
  return { apiKey: first.apiKey, baseUrl: first.baseUrl, model: first.model, provider: first.provider };
}

// Each endpoint gets its own budget, tracked from the headers the provider sends
// back. When one key is exhausted we move to the next instead of making the
// customer wait out the window.
const pace = new Map();
const chain = { current: Promise.resolve() };

function paceFor(endpoint) {
  let p = pace.get(endpoint.id);
  if (!p) {
    p = { remainingTokens: null, resetAt: 0 };
    pace.set(endpoint.id, p);
  }
  return p;
}

function parseDuration(value) {
  if (!value) return 0;
  const parts = String(value).match(/(\d+(?:\.\d+)?)(h|ms|m|s)/g) || [];
  let ms = 0;
  for (const part of parts) {
    const [, num, unit] = part.match(/(\d+(?:\.\d+)?)(h|ms|m|s)/);
    const n = Number(num);
    if (unit === 'h') ms += n * 3600000;
    else if (unit === 'm') ms += n * 60000;
    else if (unit === 'ms') ms += n;
    else ms += n * 1000;
  }
  return ms;
}

function noteLimits(p, res) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining-tokens'));
  if (Number.isFinite(remaining)) p.remainingTokens = remaining;
  const reset = parseDuration(res.headers.get('x-ratelimit-reset-tokens'));
  if (reset) p.resetAt = Date.now() + reset;
}

// The endpoint with the most room right now, preferring earlier entries (the user's
// chosen provider) when they are equally free.
function pickEndpoint(endpoints, need) {
  let best = null;
  let bestWait = Infinity;
  for (const e of endpoints) {
    const p = paceFor(e);
    const wait = Math.max(p.resetAt - Date.now(), 0);
    const room = p.remainingTokens === null || p.remainingTokens >= need;
    if (room && wait <= 0) return e;
    const score = (room ? 0 : 1000000) + wait;
    if (score < bestWait) {
      bestWait = score;
      best = e;
    }
  }
  return best || endpoints[0];
}

function estimateTokens(messages, tools, maxTokens) {
  return Math.ceil(JSON.stringify({ messages, tools }).length / 4) + maxTokens + 200;
}

async function callEndpoint(endpoint, body) {
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  return { res, text };
}

export async function chatCompletion({ endpoints, messages, tools, toolChoice, temperature = 0.6 }) {
  const maxTokens = 600;
  const body = { model: null, messages, temperature, max_tokens: maxTokens };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  const estimate = estimateTokens(messages, tools, maxTokens);

  const run = async () => {
    const tried = new Set();
    let lastError = null;

    // Try every key once. A key that is out of budget makes us try the next one
    // immediately; only when all of them are out do we wait for the nearest window.
    for (let attempt = 0; attempt < endpoints.length + 2; attempt++) {
      const endpoint = pickEndpoint(endpoints, estimate);
      const p = paceFor(endpoint);
      const wait = p.resetAt - Date.now();
      if (p.remainingTokens !== null && p.remainingTokens < estimate && wait > 0 && tried.has(endpoint.id)) {
        // Everything is exhausted; wait for the soonest window to reopen.
        const soonest = Math.min(...endpoints.map((e) => Math.max(paceFor(e).resetAt - Date.now(), 0)));
        const sleep = Math.min(soonest + 1000, 65000);
        if (sleep > 1500) logWait(sleep);
        await new Promise((r) => setTimeout(r, sleep));
      }

      tried.add(endpoint.id);
      let res;
      let text;
      try {
        ({ res, text } = await callEndpoint(endpoint, { ...body, model: endpoint.model }));
      } catch (e) {
        // A network or timeout problem with one provider should not take the agent
        // down; move on to the next key.
        lastError = new Error(`Could not reach the AI provider: ${e.message}`);
        continue;
      }
      noteLimits(p, res);

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`LLM returned non-JSON response (${res.status}): ${text.slice(0, 200)}`);
      }

      if (res.ok) {
        const choice = data.choices?.[0]?.message;
        if (!choice) throw new Error('LLM returned no choices.');
        return choice;
      }

      const msg = data?.error?.message || data?.message || text.slice(0, 300);
      if (res.status === 429) {
        // Mark this key as spent so the next attempt prefers another one.
        p.remainingTokens = 0;
        const wait2 = rateLimitWait(res, p);
        if (!p.resetAt || p.resetAt < Date.now()) p.resetAt = Date.now() + wait2;
        lastError = new Error('The AI provider is rate limiting us right now.');
        lastError.rateLimited = true;
        lastError.retryAfterMs = wait2;
        continue;
      }
      throw new Error(`LLM error ${res.status}: ${msg}`);
    }

    throw lastError || new Error('All configured AI keys are unavailable right now.');
  };

  // One request at a time, so concurrent customers share the budget instead of
  // racing each other into a rate limit.
  const result = chain.current.then(run, run);
  chain.current = result.catch(() => {});
  return result;
}

// Groq reports the wait in the retry-after header, and otherwise quotes a number
// of seconds inside the message ("Please try again in 6.1s").
function rateLimitWait(res, p) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000 + 500, 65000);
  const wait = (p?.resetAt || 0) - Date.now();
  if (wait > 0) return Math.min(wait + 1000, 65000);
  return 20000;
}

function logWait(ms) {
  if (ms > 1500) console.log(`[llm] waiting ${Math.round(ms / 1000)}s for the rate limit window`);
}

export async function generateReply(config, messages, tools, toolChoice) {
  const endpoints = resolveEndpoints(config);
  return chatCompletion({ endpoints, messages, tools, toolChoice });
}

// Every configured key, so the settings screen can show what is in the pool and
// test each one.
export async function listModels(config) {
  const endpoints = resolveEndpoints(config);
  const first = endpoints[0];
  const res = await fetch(`${first.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${first.apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Provider returned non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `Provider error ${res.status}`);
  }
  const ids = (data?.data || [])
    .map((m) => m.id)
    .filter((id) => id && !/whisper|guard|tts|orpheus|embed|moderation/i.test(id))
    .sort();
  return { model: first.model, models: ids };
}

export function endpointSummary(config) {
  return resolveEndpoints(config).map((e) => ({ provider: e.provider, label: e.label, model: e.model }));
}
