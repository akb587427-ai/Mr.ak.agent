export const PROVIDERS = {
  groq: {
    label: 'Groq (fast, free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
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

export function resolveLlm(config) {
  const p = PROVIDERS[config.provider] || PROVIDERS.custom;
  const baseUrl = (config.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
  const model = config.model || p.defaultModel;
  if (!config.apiKey) throw new Error('No LLM API key set. Open Settings in the web app and add one.');
  if (!baseUrl) throw new Error('No base URL set for the LLM provider.');
  if (!model) throw new Error('No model set for the LLM provider.');
  return { apiKey: config.apiKey, baseUrl, model, provider: config.provider };
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

export async function generateReply(config, messages, tools) {
  const llm = resolveLlm(config);
  return chatCompletion({ ...llm, messages, tools });
}
