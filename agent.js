import { generateReply } from './llm.js';
import { toolDefinitions, runTool } from './tools.js';
import { getHistory, appendHistory, log, store } from './store.js';

const MAX_TOOL_ROUNDS = 3;

export async function respond(jid, userText) {
  const config = store.config;
  const messages = [
    { role: 'system', content: config.systemPrompt },
    ...getHistory(jid),
    { role: 'user', content: userText },
  ];

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
          result = await runTool(call.function.name, args);
        } catch (e) {
          result = `Tool error: ${e.message}`;
        }
        log('info', `Tool ${call.function.name} -> ${String(result).slice(0, 120)}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
      continue;
    }
    reply = (choice.content || '').trim();
    break;
  }

  if (!reply) reply = 'Sorry, I could not produce a reply right now. Please try again.';
  appendHistory(jid, 'user', userText);
  appendHistory(jid, 'assistant', reply);
  return reply;
}
