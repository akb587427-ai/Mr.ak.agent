# AGENTS.md

## Project
WhatsApp AI Agent: Node/ESM app that links WhatsApp via Baileys and replies using a
user-supplied OpenAI-compatible LLM.

## Run / verify
- Install: `npm install`
- Run: `PORT=12000 node server.js` (or `./start.sh` for auto-restart)
- Supervise: `bash watchdog.sh` restarts the app when it crashes, when it stops
  answering while still alive, and when WhatsApp stays disconnected; detach it with
  `bash ensure-running.sh`. Tune with `CHECK_INTERVAL`, `FAIL_THRESHOLD`,
  `MIN_UPTIME_BEFORE_TRUST`.
- State: `curl localhost:12000/api/state`
- Syntax check: `node --check <file>` (and `bash -n <file>` for scripts)

## Layout
- `server.js` REST + WS, `whatsapp.js` Baileys, `agent.js` tool loop, `llm.js` providers,
  `tools.js` remember_customer/alert_owner, `store.js` persistence, `public/` UI.
- `watchdog.sh` health supervisor, `ensure-running.sh` detached launcher, `start.sh`
  inner restart loop.

## Notes
- The managed OpenHands LLM proxy rejects external apps (403), so the app requires the
  user to supply their own LLM API key.
- DuckDuckGo HTML endpoints return a bot challenge; use the Wikipedia API plus the DDG
  instant-answer API for search instead.
- Public runtime URLs are `https://work-1-<runtime>.prod-runtime.all-hands.dev/` (port 12000)
  and `https://work-2-...` (port 12001); they are open without extra auth.
- `data/` holds config (plain-text API key), chat memory, and WhatsApp auth; it is gitignored.
- There is no systemd or cron here (PID 1 is `openhands-agent-server`), so autostart
  relies on a hook in `~/.bashrc` and `~/.profile` that runs `ensure-running.sh`.
- Free-tier LLM limits drive most behaviour: Gemini counts quota per model per day, so
  one key is spread across several models, and Pollinations (keyless) allows roughly
  one reply per 30s per IP. See README "Notes and limits".
