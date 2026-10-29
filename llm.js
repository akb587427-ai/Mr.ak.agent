export const PROVIDERS = {
  pollinations: {
    label: 'Pollinations (free, no key needed)',
    baseUrl: 'https://text.pollinations.ai/openai',
    defaultModel: 'openai',
    keyless: true,
  },
  gemini: {
    label: 'Google Gemini (free tier, generous limits)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // A dated model name stops working once Google retires it, so this points at a
    // current one and the extra models below act as daily-quota spare capacity.
    defaultModel: 'gemini-3.1-flash-lite',
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

// Gemini's free tier counts quota per model per day, so spreading requests across
// several models multiplies the daily capacity instead of burning through one in a
// few minutes. The "-latest" aliases survive model retirements.
const GEMINI_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

// One entry per usable key, ordered so the key the user picked in the dropdown is
// tried first. Any key whose provider is recognised on its own gets that provider's
// endpoint, even if the dropdown is on something else.
export function resolveEndpoints(config) {
  const keys = splitKeys(config.apiKey);
  const chosen = config.provider || 'custom';
  const chosenPreset = presetFor(chosen);

  // Some providers need no key at all. They are always available, so the agent can
  // answer out of the box, and they stay in the pool as spare capacity even when
  // paid or limited keys are configured alongside them.
  const keyless = [];
  if (chosenPreset.keyless && !keys.length) {
    keyless.push({
      id: `keyless:${chosenPreset.baseUrl}`,
      apiKey: '',
      baseUrl: (chosenPreset.baseUrl || '').replace(/\/+$/, ''),
      model: config.model || chosenPreset.defaultModel,
      provider: chosen,
      label: chosenPreset.label,
      keyless: true,
    });
  }

  if (!keys.length) {
    if (keyless.length) return keyless;
    throw new Error('No LLM API key set. Open AI settings in the web app and add one.');
  }

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
      id: `${provider}:${baseUrl}:${key.slice(-6)}:${model}`,
      apiKey: key,
      baseUrl,
      model,
      provider,
      label: `${preset.label || provider} (…${key.slice(-4)})`,
    });

    // Gemini counts the daily free quota per model, so one key can be spread over
    // several models. The user's own model stays first; the rest follow as extra
    // capacity for when it runs out for the day.
    if (provider === 'gemini') {
      const extra = [model, ...GEMINI_MODELS].filter(
        (m, i, all) => m && all.indexOf(m) === i,
      );
      for (const m of extra.slice(1)) {
        endpoints.push({
          id: `gemini:${baseUrl}:${key.slice(-6)}:${m}`,
          apiKey: key,
          baseUrl,
          model: m,
          provider,
          label: `${preset.label || provider} (…${key.slice(-4)})`,
        });
      }
    }
  }

  if (!endpoints.length) {
    throw new Error('No usable LLM endpoint. Pick a provider or set the base URL in AI settings.');
  }

  // Keep the user's chosen provider in front, the rest as spare capacity.
  endpoints.sort((a, b) => (a.provider === chosen ? -1 : 0) - (b.provider === chosen ? -1 : 0));

  // Always keep one keyless provider at the end of the queue. It costs nothing and
  // needs no signup, so a missing, expired or exhausted key still leaves the agent
  // able to answer a customer instead of going silent.
  const fallback = PROVIDERS.pollinations;
  if (!endpoints.some((e) => e.provider === 'pollinations')) {
    endpoints.push({
      id: `keyless:${fallback.baseUrl}`,
      apiKey: '',
      baseUrl: fallback.baseUrl,
      model: fallback.defaultModel,
      provider: 'pollinations',
      label: fallback.label,
      keyless: true,
    });
  }
  return endpoints;
}

// Kept for the settings screen, which shows one endpoint at a time.
export function resolveLlm(config) {
  const [first] = resolveEndpoints(config);
  return { apiKey: first.apiKey, baseUrl: first.baseUrl, model: first.model, provider: first.provider };
}

// Some providers quote the wait inside the message instead of a header, for example
// Pollinations' "Retry after 22s". Reading it lets us pace that provider properly.
function parseRetryFromMessage(msg) {
  const m = String(msg || '').match(/retry after\s+(\d+(?:\.\d+)?)\s*(ms|s|seconds?|m|minutes?)?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  if (unit.startsWith('ms')) return n;
  if (unit.startsWith('m')) return n * 60000;
  return n * 1000;
}

// A provider with no key is shared by everyone, so a light brake between requests
// stops us hammering it. The provider's own limit messages set the real spacing; this
// only covers the case where it accepts a request without saying anything.
const KEYLESS_MIN_GAP_MS = 30000;
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
  const now = Date.now();
  let best = null;
  let bestWait = Infinity;
  for (const e of endpoints) {
    const p = paceFor(e);
    const wait = Math.max(p.resetAt - now, 0);
    // Once the window has passed the counter starts fresh, so a key marked as spent
    // becomes usable again without another request to confirm it.
    if (wait <= 0) p.remainingTokens = null;
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
  const headers = { 'Content-Type': 'application/json' };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  return { res, text };
}

// One request to one endpoint. Returns the model's message, or throws. A limit is
// recorded on the endpoint so the caller can pick a different one next time.
async function requestEndpoint(endpoint, body) {
  const p = paceFor(endpoint);
  p.lastCallAt = Date.now();
  let res;
  let text;
  try {
    ({ res, text } = await callEndpoint(endpoint, { ...body, model: endpoint.model }));
  } catch (e) {
    const err = new Error(`Could not reach the AI provider: ${e.message}`);
    err.network = true;
    throw err;
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
  // A provider can report a full or overloaded service in several ways: 429 for a
  // rate limit, 402 for a free-tier cap, and 503 when the shared free capacity is
  // busy. Any of them that quotes a delay is treated as a limit so the caller waits
  // the quoted time or moves to another endpoint instead of giving up.
  const quoted = parseRetryFromMessage(msg);
  const limited =
    res.status === 429 ||
    res.status === 402 ||
    ((res.status === 503 || res.status === 500) && quoted > 0) ||
    (quoted > 0 && /limit|busy|overload|try again/i.test(msg));
  const err = new Error(
    limited ? 'The AI provider is rate limiting us right now.' : `LLM error ${res.status}: ${msg}`,
  );
  if (limited) {
    const wait = rateLimitWait(res, p, msg);
    err.rateLimited = true;
    err.retryAfterMs = wait;
    p.remainingTokens = 0;
    p.resetAt = Math.max(p.resetAt, Date.now() + wait);
  }
  throw err;
}

export async function chatCompletion({ endpoints, messages, tools, toolChoice, temperature = 0.6 }) {
  const maxTokens = 600;
  const body = { messages, temperature, max_tokens: maxTokens };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  const estimate = estimateTokens(messages, tools, maxTokens);

  const run = async () => {
    let lastError = null;

    // Walk the endpoints in order of how soon they can answer. If one is limited,
    // move straight to the next; only when none can answer do we wait for the
    // soonest limit to lift, then try again. This keeps a customer's reply flowing
    // across free tiers instead of failing the moment one key runs dry.
    for (let round = 0; round < 8; round++) {
      const order = [...endpoints].sort((a, b) => {
        const pa = paceFor(a);
        const pb = paceFor(b);
        const wa = pa.remainingTokens === null ? 0 : Math.max(pa.resetAt - Date.now(), 0);
        const wb = pb.remainingTokens === null ? 0 : Math.max(pb.resetAt - Date.now(), 0);
        return wa - wb;
      });

      let sawLimit = false;
      for (const endpoint of order) {
        const p = paceFor(endpoint);
        const wait = p.remainingTokens === null ? 0 : Math.max(p.resetAt - Date.now(), 0);
        if (wait > 0) {
          sawLimit = true;
          continue;
        }
        // A keyless provider is shared by everyone, so space its requests out. The
        // floor applies even after a limit message, because that message only reflects
        // the moment it was sent.
        if (
          endpoint.keyless &&
          p.lastCallAt &&
          Date.now() - p.lastCallAt < KEYLESS_MIN_GAP_MS
        ) {
          sawLimit = true;
          continue;
        }
        try {
          return await requestEndpoint(endpoint, body);
        } catch (e) {
          lastError = e;
          if (e.rateLimited) {
            sawLimit = true;
            continue;
          }
          // A rejected key, unknown model or a network fault should not take the
          // agent offline while another endpoint is still available.
          continue;
        }
      }

      if (!sawLimit) break;

      // Wait until the nearest endpoint can answer again. For a keyless provider the
      // shared floor applies even when it quoted a shorter retry, since its real limit
      // is per IP and the quote only reflects one moment.
      const readyAt = (e) => {
        const p = paceFor(e);
        const times = [];
        if (p.resetAt > Date.now()) times.push(p.resetAt);
        if (e.keyless && p.lastCallAt) times.push(p.lastCallAt + KEYLESS_MIN_GAP_MS);
        return times.length ? Math.max(...times) : Date.now();
      };
      const soonest = Math.min(...endpoints.map((e) => readyAt(e) - Date.now()));
      const sleep = Math.max(Math.min(soonest + 1000, 65000), 2000);
      logWait(sleep);
      await new Promise((r) => setTimeout(r, sleep));
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
function rateLimitWait(res, p, msg) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000 + 500, 65000);
  const fromMsg = parseRetryFromMessage(msg);
  if (fromMsg > 0) return Math.min(fromMsg + 1000, 65000);
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
