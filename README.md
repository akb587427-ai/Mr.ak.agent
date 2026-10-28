# WhatsApp AI Agent

A small self-hosted web app that links your WhatsApp account and runs an AI agent
that answers your incoming WhatsApp messages.

## What it does

- Pairs with WhatsApp by scanning a QR code (WhatsApp Web multi-device).
- Answers direct messages with an LLM of your choice (Groq, OpenAI, OpenRouter,
  Together, DeepSeek, or any OpenAI-compatible endpoint).
- Gives the agent two tools: `web_search` (Wikipedia + DuckDuckGo instant answers)
  and `current_time`.
- Keeps short per-chat memory and shows a live activity log.

## Run

```bash
npm install
npm start          # listens on http://0.0.0.0:12000
```

Open the web page, then:

1. Scan the QR code: WhatsApp on your phone -> Settings -> Linked devices ->
   Link a device.
2. Pick a provider, paste your LLM API key, set a model, and press Save.
   Press Test AI to confirm the key works.
3. Send a WhatsApp message to the linked number from another phone.

## Settings

| Field | Meaning |
| --- | --- |
| Provider | Which LLM service to call. `custom` accepts any OpenAI-compatible base URL. |
| API key | Your own LLM key. Stored in `data/config.json` on this machine. |
| Model | Model name. Defaults are filled per provider. |
| Base URL | Only needed for `custom`. |
| System prompt | The agent's instructions. |
| Trigger prefix | Optional. If set, the agent only replies to messages that start with it. |
| Agent enabled | Master on/off switch. |
| Reply in groups | Off by default, so the agent stays quiet in group chats. |

## Files

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP API + WebSocket state stream, serves the web UI. |
| `whatsapp.js` | Baileys socket, QR pairing, reconnect, message routing. |
| `agent.js` | Builds the prompt, runs the tool loop, saves memory. |
| `llm.js` | Provider table and chat-completions client. |
| `tools.js` | `web_search` and `current_time` tools. |
| `store.js` | Config, chat memory, and activity log on disk. |
| `public/` | The web UI. |

## Notes and limits

- This links your WhatsApp as a companion device. Keep your phone online; WhatsApp
  unlinks companions that stay offline for long.
- Sessions are stored in `data/auth`. Log out from the UI to unlink and clear them.
- The API key lives in plain text in `data/config.json`. Do not commit it.
