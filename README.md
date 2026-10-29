# WhatsApp AI Agent

A small self-hosted web app that links your WhatsApp account and runs an AI agent
that answers your incoming WhatsApp messages.

## What it does

- Links WhatsApp by QR code or by an 8-character pairing code (phone number entry).
- Answers direct messages with an LLM of your choice (Google Gemini, Groq, OpenAI,
  OpenRouter, Together, DeepSeek, or any OpenAI-compatible endpoint). The provider is
  filled in automatically from the API key, so a pasted key works even if the dropdown
  was left on Custom.
- Accepts several API keys at once, separated by commas. Each free key has its own
  per-minute limit, so two or three keys give the agent a comfortable budget. When one
  key is rate limited the agent moves to the next instead of making the customer wait.
- Gives the agent tools: `web_search`, `current_time`, `remember_customer`
  (builds a profile per chat) and `alert_owner` / `save_lead` (hands a qualified
  customer to the owner).
- Remembers each customer across conversations, so it never asks twice.
- DMs the owner's WhatsApp for every qualified customer. Set the number in the
  "Your WhatsApp number for lead alerts" field and use Send test alert to check.
- Keeps short per-chat memory and shows a live activity log.
- Trained on the TECH ARSLAN business brief held in `knowledge.js`, editable from
  the Business knowledge box in the web app. It covers the eight business software
  products with prices, plus the online digital services sold on request (social
  media growth, monetization and approvals, ad accounts, RDP and servers,
  international and virtual numbers, PayPal and Payoneer accounts, domains and
  hosting, and more).
- Qualifies customers and saves their details to the Customer panel.

## Training the agent on your business

The agent's knowledge lives in `knowledge.js`. It is appended to the system prompt
on every reply, so it always knows:

- who the company is and who to contact
- all eight software products with prices and features
- the online digital services offered on request
- answers to the common questions
- how to talk to customers and when to hand over to a human

To change any of it, edit the Business knowledge box in the web app and press
Save settings, or edit `knowledge.js` directly. No restart is needed for the
web app path.

## Run

```bash
npm install
npm start          # listens on http://0.0.0.0:12000
```

Keep it alive across crashes and restarts:

```bash
bash ensure-running.sh   # starts it if not already running (safe to call anytime)
```

Logs are written to `logs/server.log`.

Open the web page, then:

1. Link your WhatsApp in one of two ways:
   - **QR code**: WhatsApp on your phone -> Settings -> Linked devices -> Link a
     device, then scan the QR shown on the page.
   - **Pairing code**: open "Link with phone number instead" on the page, enter your
     number with country code (no `+`, e.g. `923001234567`), press Get code, then on
     your phone go to Linked devices -> Link a device -> Link with phone number
     instead and type the 8-character code.
2. Pick a provider, paste your LLM API key, set a model, and press Save.
   Press Test AI to confirm the key works.
3. Send a WhatsApp message to the linked number from another phone.

## Settings

| Field | Meaning |
| --- | --- |
| Provider | Which LLM service to call. `custom` accepts any OpenAI-compatible base URL. |
| API key | Your own LLM key. Stored in `data/config.json` on this machine. |
| Model | Model name. Defaults are filled per provider, or press Load models to pick from the list. |
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
- Free tiers limit how many tokens a key may use per minute, and every reply carries
  the whole business brief, so one Groq free key answers only about two messages a
  minute. Google Gemini's free tier is far more generous, so it is the recommended
  default. Adding a second or third free key from any provider raises the budget
  further; the agent spreads requests across them and only waits when all are spent.
