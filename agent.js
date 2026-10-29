import { generateReply } from './llm.js';
import { toolDefinitions, runTool, handoffToOwner } from './tools.js';
import {
  getHistory,
  appendHistory,
  customerDigest,
  getCustomer,
  needsOwnerAlert,
  log,
  store,
} from './store.js';

const MAX_TOOL_ROUNDS = 4;

// The model does not reliably call tools on its own. This forces one tool call
// whose only job is to pull the customer's details out of the conversation, so
// memory and the owner handoff do not depend on the model remembering to do it.
async function extractCustomer(config, jid, transcript) {
  const schema = toolDefinitions.find((t) => t.function.name === 'remember_customer');
  if (!schema) return;
  try {
    const choice = await generateReply(
      config,
      [
        {
          role: 'system',
          content:
            'You read a WhatsApp conversation between a customer and the TECH ARSLAN sales assistant. Report only facts the customer actually stated. Never guess. Leave a field empty if the customer did not say it.',
        },
        { role: 'user', content: transcript },
      ],
      [schema],
      { type: 'function', function: { name: 'remember_customer' } },
    );
    const call = choice?.tool_calls?.[0];
    if (!call) return;
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return;
    }
    await runTool('remember_customer', args, { jid });
  } catch (e) {
    log('warn', 'Customer extraction failed', e.message);
  }
}

export async function respond(jid, userText, ctx = {}) {
  const config = store.config;
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
      continue;
    }
    reply = (choice.content || '').trim();
    break;
  }

  if (!reply) reply = 'Sorry, I could not produce a reply right now. Please try again.';
  appendHistory(jid, 'user', userText);
  appendHistory(jid, 'assistant', reply);

  // Pull whatever the customer revealed into their profile, then make sure the
  // owner is alerted exactly once, even if the model never called a tool itself.
  const transcript = getHistory(jid)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`)
    .join('\n');
  await extractCustomer(config, jid, transcript);

  if (needsOwnerAlert(jid)) {
    const c = getCustomer(jid);
    log('info', `Auto-handing over ${c.name} to owner`);
    handoffToOwner(c, 'Customer shared their details and interest.', ctx.notifyOwner);
  }

  return { reply, isNew };
}
