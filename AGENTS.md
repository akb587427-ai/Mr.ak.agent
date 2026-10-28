# AGENTS.md

## Project
WhatsApp AI Agent: Node/ESM app that links WhatsApp via Baileys and replies using a
user-supplied OpenAI-compatible LLM.

## Run / verify
- Install: `npm install`
- Run: `PORT=12000 node server.js` (or `./start.sh` for auto-restart)
- State: `curl localhost:12000/api/state`
- Syntax check: `node --check <file>`

## Layout
- `server.js` REST + WS, `whatsapp.js` Baileys, `agent.js` tool loop, `llm.js` providers,
  `tools.js` web_search/current_time, `store.js` persistence, `public/` UI.

## Notes
- The managed OpenHands LLM proxy rejects external apps (403), so the app requires the
  user to supply their own LLM API key.
- DuckDuckGo HTML endpoints return a bot challenge; use the Wikipedia API plus the DDG
  instant-answer API for search instead.
- Public runtime URLs are `https://work-1-<runtime>.prod-runtime.all-hands.dev/` (port 12000)
  and `https://work-2-...` (port 12001); they are open without extra auth.
- `data/` holds config (plain-text API key), chat memory, and WhatsApp auth; it is gitignored.
