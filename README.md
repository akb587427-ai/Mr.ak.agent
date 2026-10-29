# WhatsApp AI Agent

A small self-hosted web app that links your WhatsApp account and runs an AI agent
that answers your incoming WhatsApp messages.

## What it does

- Links WhatsApp by QR code or by an 8-character pairing code (phone number entry).
- Works with no setup at all: if no key is set it uses Pollinations, a free service
  that needs no signup. It stays in the queue as a backstop even when you add keys, so
  an expired or exhausted key never leaves the agent silent.
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
bash ensure-running.sh   # starts the watchdog if it is not already up (safe to call anytime)
```

For a long unattended run use the watchdog rather than `npm start`. It restarts the
app when it crashes, when the web app stops answering even though the process is
still alive, and when WhatsApp stays disconnected too long. It also rotates the logs
so they cannot fill the disk.

```bash
bash watchdog.sh         # runs in the foreground; use ensure-running.sh to detach it
```

Behaviour can be tuned with environment variables: `CHECK_INTERVAL` (seconds between
checks, default 30), `FAIL_THRESHOLD` (bad checks before a restart, default 4), and
`MIN_UPTIME_BEFORE_TRUST` (a restart sooner than this counts as a crash loop and adds
a back-off, default 60).

On this machine there is no systemd or cron, so the autostart hook in `~/.bashrc` and
`~/.profile` re-launches the watchdog whenever a shell starts, which covers a
container restart. Logs are written to `logs/server.log` and `logs/watchdog.log`.

## Deploy to a host (Railway and similar)

The sandbox this was built in stops the whole machine at will, and a non-interactive
shell never sources `~/.bashrc`, so the autostart hook cannot be relied on there. A
hosted container is the durable option. `Dockerfile`, `railway.json` and
`.dockerignore` are already in the repo.

On Railway:

1. Push this repo to GitHub, then in Railway choose **New Project -> Deploy from
   GitHub repo**. Railway reads `railway.json` and builds the Dockerfile.
2. Add a **Volume** to the service and mount it at `/data`. The image already sets
   `DATA_DIR=/data` and `AUTH_DIR=/data/auth`, so the WhatsApp session, the config and
   the chat history survive every redeploy. Without the volume a redeploy logs you out
   of WhatsApp and you must scan the QR again.
3. In **Variables**, set `LLM_API_KEY` and `OWNER_NUMBER`. These only seed the first
   boot; once the dashboard saves them, the volume copy wins and the variables can be
   removed.
4. Under **Settings -> Networking**, press **Generate Domain**. That URL is public and
   stable, unlike the sandbox one.
5. Open the URL, scan the QR once, and the agent is live.

Notes for this host:

- Do not enable **Serverless / App Sleep**. It puts the service to sleep after ten
  minutes with no outbound traffic. A WhatsApp connection is a long-lived socket, so
  the service must stay awake to receive messages.
- The free plan caps restarts at ten, so the watchdog is doing the real work of
  keeping the process alive; the platform policy only covers the watchdog itself
  exiting.
- `railway.json` points the healthcheck at `/api/state`, which answers `200` once the
  web app is up. A healthcheck only runs at deploy time, not continuously.

Any Docker host works the same way: `docker build -t wa-agent .` then
`docker run -p 12000:12000 -v wa-data:/data -e LLM_API_KEY=... -e OWNER_NUMBER=... wa-agent`.

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
- Free tiers limit how much a key may use. A Groq free key allows about 8,000 tokens
  a minute, which is roughly two replies, so a single Groq key is not enough on its
  own. Google Gemini counts its free quota per model per day, so the agent spreads one
  Gemini key across several models and holds about five times the daily capacity. Add
  a second or third key from any provider to raise it further; the agent spreads
  requests across all of them and only waits when every one is spent.
- With no key at all the agent answers through Pollinations, which needs no signup and
  allows about one reply every 30 seconds per IP. It always stays at the end of the
  queue, so an expired or exhausted key never leaves a customer unanswered.
