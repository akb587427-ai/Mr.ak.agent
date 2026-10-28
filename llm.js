export const PROVIDERS = {
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

export function resolveLlm(config) {
  const { apiKey } = config;
  if (!apiKey) {
    throw new Error('No LLM API key set. Open AI settings in the web app and add one.');
  }

  let provider = config.provider || 'custom';
  let preset = PROVIDERS[provider] || PROVIDERS.custom;
  let baseUrl = (config.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  let model = config.model || preset.defaultModel;

  // A key alone is often enough to pick the endpoint (for example a "gsk_" key is
  // Groq). This rescues the common case where provider stayed on "custom" with
  // empty fields, which otherwise fails every message.
  if (!baseUrl || !model) {
    const detected = detectProviderFromKey(apiKey);
    if (detected && PROVIDERS[detected]) {
      provider = detected;
      preset = PROVIDERS[detected];
      baseUrl = baseUrl || (preset.baseUrl || '').replace(/\/+$/, '');
      model = model || preset.defaultModel;
    }
  }

  if (!baseUrl) {
    throw new Error(`No base URL set. Pick a provider (for example Groq) or paste the base URL for "${provider}".`);
  }
  if (!model) {
    throw new Error(`No model set. Pick a provider or type a model name for "${provider}".`);
  }
  return { apiKey, baseUrl, model, provider };
}

export async function chatCompletion({ apiKey, baseUrl, model, messages, tools, temperature = 0.6 }) {
  const body = { model, messages, temperature, max_tokens: 900 };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LLM returned non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 300);
    throw new Error(`LLM error ${res.status}: ${msg}`);
  }
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error('LLM returned no choices.');
  return choice;
}

export async function listModels(config) {
  const llm = resolveLlm(config);
  const res = await fetch(`${llm.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${llm.apiKey}` },
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
  return { model: llm.model, models: ids };
}

export async function generateReply(config, messages, tools) {
  const llm = resolveLlm(config);
  return chatCompletion({ ...llm, messages, tools });
}
