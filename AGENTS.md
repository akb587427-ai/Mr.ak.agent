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
- There is no systemd or cron here (PID 1 is `openhands-agent-server`), and shells are
  **non-interactive**, so `~/.bashrc` is never sourced — an autostart hook there does
  not fire. The sandbox also stops the whole machine without warning. Treat this
  environment as non-durable and deploy to a host for anything long-lived.
- Deployment files: `Dockerfile` (hosts `watchdog.sh` as the entrypoint, via tini),
  `railway.json` (healthcheck `/api/state`), `deploy/whatsapp-ai-agent.service`
  (systemd unit for a VPS). See README "Deploy to a host".
- `DATA_DIR` and `AUTH_DIR` are read from the environment, which is how a mounted
  volume keeps the WhatsApp session and config across a redeploy. Both must be set:
  `DATA_DIR` covers config/history/leads, `AUTH_DIR` the Baileys session.
- `LLM_API_KEY` and `OWNER_NUMBER` seed a fresh volume's config on first boot only; a
  saved config always wins.
- `LOG_STDOUT=1` mirrors the log files to stdout for platform log collection.
- Free-tier LLM limits drive most behaviour: Gemini counts quota per model per day, so
  one key is spread across several models, and Pollinations (keyless) allows roughly
  one reply per 30s per IP. See README "Notes and limits".
- The GitHub repo is `akb587427-ai/Mr.ak.agent` (public), branch `main`. The repo was
  pushed with the OAuth token in `~/.config/gh/hosts.yml`; the `GITHUB_TOKEN`
  environment variable is a read-only GitHub App token and is rejected (403) for
  writes, even though the API reports `push: true`.
- `railway.json`, `Dockerfile` and `.dockerignore` are the deploy files; the service
  must have a Volume at `/data` or a redeploy logs the user out of WhatsApp.

## Hosting search results (checked the live pages, 2026-10-29)
- **Railway**: signup is disabled for new accounts ("Sign ups are currently disabled").
- **Northflank**: advertises "Sandbox Free, no card needed", but creating a service fails
  with HTTP 409 "Please complete your account by adding a default payment method". Its
  cheapest deployment plan is nf-compute-10 at $2.70/month.
- **alwaysdata**: the 0 EUR plan is real, but always-on daemons (Advanced > Services) are
  paid-plan only, so the free plan cannot keep the agent running unattended.
- **Render Free**: no card, but a free web service spins down after 15 minutes without
  inbound traffic and free services cannot attach a persistent disk, so the WhatsApp
  session would be lost on every spin-down. Not usable for this agent.
- **Back4app Containers**: free plan, "no credit card required", builds a Dockerfile from
  GitHub. The most promising remaining option; needs a browser signup.
- The sandbox public URL (`https://work-1-*.prod-runtime.all-hands.dev/`) is live and the
  agent is reachable there, but the sandbox stops the machine at will, so it is not the
  durable host the task asked for.

## DEPLOYED HOST: The Vibe Hosting (working, 2026-10-29)

The agent is live at **https://techarslan-ai.thevibehosting.com/** — a real root Linux
box (gVisor sandbox, Ubuntu 24.04) that the task's "free, no-card, always-on" criterion
actually satisfies. This replaced the sandbox link, which died on the runtime's 20-minute
idle timeout (`OH_RUNTIME_IDLE_TIMEOUT_SECONDS=1200`).

Account and server details:
- Server id `srv_5fecb9fe49`, subdomain `techarslan-ai.thevibehosting.com`, tier `anonymous`.
- SSH: `ssh -i ~/.vibe/key -o IdentitiesOnly=yes root@167.233.42.250 -p 35437`
  (port is NOT 22; `IdentitiesOnly=yes` is required). Key at `~/.vibe/key` (0600),
  account JSON at `~/.vibe/account.json`. Both are local-only, never committed.
- Control plane API: `https://thevibehosting.com` with `Authorization: Bearer <api_key>`.
  Useful endpoints: `GET /servers/{id}`, `GET /account/billing`, `POST /servers/{id}/sleep`,
  `POST /servers/{id}/wake`, `POST /servers/{id}/never-sleep`.

How the app runs there:
- Code lives in `/root/myapp`; `npm ci --omit=dev` was run once.
- The platform supervisor serves port **80** and runs `/root/run.sh` (which it detects and
  auto-restarts on crash and after every wake). `run.sh` execs `watchdog.sh` with
  `PORT=80 DATA_DIR=/root/myapp/data AUTH_DIR=/root/myapp/data/auth LOG_STDOUT=1`.
- Node on the box was 18.19.1 (Baileys requires >=20), so Node **24.22.2** was unpacked
  into `/usr/local`. Tools installed with apt: `xz-utils iproute2 tini rsync`.
- The WhatsApp session was migrated by rsyncing `data/` (including `data/auth`, ~1700
  files), so **no new QR scan was needed** — the agent came up already linked as
  `923494936993@s.whatsapp.net`. The old sandbox instance had to be killed first or
  Baileys reported `Stream Errored (conflict)`.

**Critical caveat — always-on needs phone verification.** Anonymous accounts cannot set
`never_sleep` (`POST /servers/{id}/never-sleep` returns 403 "always-on needs a verified
phone"). By default the box scales to zero after ~10 min idle; the disk keeps the session
so it wakes on the next request, but a customer DM that arrives while it is asleep is NOT
processed until something wakes it. Verifying a phone is free and lifts this: it also
raises the RAM ceiling 256 MB -> 2 GB and the monthly free credit $0.90 -> $2.25. A 512 MB
always-on server is then covered by the free credit. This is the one step that still needs
the user (they must receive and hand back the SMS code).

Updating the app after a change:
```bash
rsync -az --exclude .git --exclude logs --exclude node_modules \
  -e "ssh -i ~/.vibe/key -o IdentitiesOnly=yes -p 35437" ./ root@167.233.42.250:/root/myapp/
```
The free plan requires one footer line linking back to `https://thevibehosting.com`;
it is in `public/index.html` (`.attribution`).

## Always-on without phone verification (2026-10-29)

Vibe Hosting's `never_sleep` flag needs a **verified phone**, and phone verification
**does not work for Pakistani numbers**: `POST /account/verify-phone` returns
`400 {"detail":"phone verification isn't available for this number"}` for every +92
number tried (6 across the 300/311/321/333/345/349 prefixes). `+420…` and `+1415…`
numbers get a code, so this is a country restriction, not an account problem.

Instead of `never_sleep`, the box keeps itself awake from the inside:
`/root/keepalive.sh` requests its own public URL (`/api/state`) every 240s. The request
arrives through the platform edge, which counts as traffic, so the box never scales to
zero and customer DMs are answered immediately. `run.sh` starts it in the background
before exec'ing `watchdog.sh`.

This is within the free tier: the measured burn while awake is ~$0.0005/hour
(~$0.35/month at ~95-190 MB), against the $0.90/month free credit. **Do not add a second
keep-alive or shorten the interval** — it only raises the burn for no benefit.

The caveat is that keep-alive is a best effort: it survives the app crashing (the
watchdog restarts it) but a full platform restart that never re-runs `run.sh` would end
it. It also has an in-container blind spot — the loop runs inside the box it is keeping
alive, so it cannot wake the box if the loop itself is what stopped. A phone-verified
`never_sleep` remains the stronger guarantee, and needs a non-Pakistani number.

## Call system + voice notes (added)

**Incoming calls — what is and is not possible.** Baileys exposes only `rejectCall`
(`callId`, `callFrom`). There is no `acceptCall`, no SRTP/RTP stack, no WebRTC and no
audio relay, so a linked WhatsApp device cannot carry a live call. WhatsApp's own
Cloud API "Calling" product can answer calls, but it is a separate paid, Meta-verified
product (business-initiated calls are billed per minute) and cannot be driven from a
Baileys-linked number.

What the agent does instead, in `calls.js`: on a `call` event with `status: "offer"` it
rejects the ring and immediately opens the conversation — by default with a spoken
voice note — then DMs the owner. Modes are `off`, `text`, `voice`.

**Voice notes** (`voice.js`). Customer voice notes are downloaded with
`downloadMediaMessage` and transcribed by Gemini (the same key/model already in use).
Replies can be spoken back as real WhatsApp voice notes: Gemini TTS returns raw 24 kHz
PCM, `ffmpeg` re-wraps it as OGG/Opus, and it is sent with `{ audio, mimetype:
'audio/ogg; codecs=opus', ptt: true }`. This needs `ffmpeg` on the host
(`apt-get install -y ffmpeg`, done on the current box) and works on the free Gemini tier.

**Config:** `voiceReplies` (bool) and `calls: { mode, notifyOwner, greeting }`, editable
from the dashboard "Calls" section. `POST /api/test-voice` generates a note and, with
`send: true`, delivers it to the owner's DM to prove it renders.

### Voice update (male voice + model rotation)

- **Male voice by default.** `ttsVoice` (default `Charon`, a deep male Gemini voice).
  Other male voices: `Puck`, `Orus`, `Iapetus`, `Fenrir`. Female options remain
  (`Kore`, `Aoede`, `Leda`, `Zephyr`). The OpenAI path uses `onyx` (male). Selectable
  from the dashboard Calls section; `GET /api/state` returns the `voices` list.
- **Speech model rotation.** Gemini's free tier meters speech quota *per model per
  day*, so one exhausted model used to kill all voice. `voice.js` now walks
  `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-3.1-flash-tts-preview`,
  `gemini-2.5-flash-preview-tts` on 429/503, mirroring the chat-model rotation.
- **Voice notes are transcribed and answered in kind** (voice in, voice out), including
  the first-contact welcome. Transcription may come back in Devanagari or Urdu script
  depending on the speaker, which is fine — the reply is generated in the language the
  customer used.
- **Key note:** the dashboard's "N keys" figure is the number of *endpoints* (models),
  not API keys. The current box has a single Gemini key, so per-model rotation is what
  provides headroom.

### Transcription reliability (fix)

Symptom: the agent answered real customer voice notes with "Sorry, aap ka voice
message samajh nahi aaya" over and over. Cause: `transcribeGemini` used only
`store.config.model`, and Gemini's free tier returns **503 "high demand"** on a single
chat model often enough that most voice notes failed. The earlier round-trip test
passed only because it happened to run between spikes.

Fix, in `voice.js`:
- `STT_MODELS` walks `gemini-3.1-flash-lite`, `gemini-3.1-flash-lite-preview`,
  `gemini-3-flash-preview`, `gemini-flash-lite-latest`, retrying the whole list twice
  with a short pause, so a transient 503 no longer fails the customer.
- A transcription prompt that asks for the speaker's own language and script. Urdu
  speech now comes back in Roman Urdu ("bhai mujhe pharmacy ka software chahiye")
  instead of Devanagari, which reads far better to the owner and to the model.
- `whatsapp.js` separates the media download from transcription and retries once after
  4s before ever telling the customer it failed.

Verified: 5/5 consecutive transcriptions succeeded, and a full customer-speaks ->
agent-replies-in-male-voice run produced a valid OGG/Opus note, with the speech model
rotation visibly falling through from `gemini-3.8-flash-tts` (429) to
`gemini-3.8-flash-lite-tts`.

### API key health monitor (added)

A dead or disabled API key takes the whole agent offline silently: the customer gets no
reply and the owner has no idea anything is wrong. Observed live — the owner's Gemini
key began returning **401 "The bound service account is deleted or disabled"** and every
text and voice reply stopped, with nothing surfaced.

`server.js` now pings the configured model 45s after boot and every 10 minutes. On
failure it DMs the owner once (with the exact reason, and a "make a new key" pointer for
auth errors) and the dashboard shows a red banner. State is in `GET /api/state` under
`health`, rendered by `renderHealth` in `public/app.js`.

A per-model 429/503 is *not* a health failure — that is handled by the existing rotation
in `llm.js` and `voice.js`. Only a failure that survives rotation trips the alert.

### Provider/key change must clear recorded limits

`llm.js` keeps per-endpoint rate-limit state in a `pace` map keyed by endpoint id, which
includes the base URL. Changing the provider left the *old* provider's `resetAt` in place,
so the agent sat out a window that no longer applied — seen live as
`[llm] waiting 31s for the rate limit window` followed by a 30s request timeout and
`Could not reach the AI provider`. The app looked broken while a plain `fetch` to the same
URL returned 200 in under a second. `resetPacing()` now clears the map and the request
chain, and `/api/config` calls it on every save.

### Keyless provider is a valid configuration

`checkKey()` treated "no API key" as a failure even when the chosen provider is keyless
(Pollinations). It now only flags a missing key when the provider actually needs one, so
the keyless fallback does not spam the owner with false alarms.

Note on limits: keyless providers are shared and slow down under load, so Pollinations is
a text-only stopgap. Voice replies and reliable throughput need a real Gemini key.

### Free keyless voice output (edge-tts)

Gemini TTS needs a working key and meters speech quota per model per day, so a missing or
exhausted key used to silence voice replies entirely. `voice.js` now also speaks through
Microsoft Edge's read-aloud voices via the `edge-tts` utility: free, unlimited, no key,
no quota. Install with `pip install --break-system-packages edge-tts`.

- Voice ids prefixed `edge:` select these voices (`edge:ur-PK-AsadNeural` is male Urdu).
- The default voice is `edge:ur-PK-AsadNeural`, so voice works with no key at all.
- A Gemini voice that fails falls back to the free Edge male voice rather than failing.
- `voiceReady()` is true when a key exists **or** edge-tts is installed, so incoming
  voice notes are not ignored just because no key is configured.

Verified: 4/4 free voices produced valid OGG/Opus voice notes with no key configured.

### Whisper model depends on the provider

Groq serves Whisper as `whisper-large-v3-turbo`, not `whisper-1`; sending OpenAI's model
name to Groq 404s. `transcribeOpenAI` now picks the model from the configured provider.
Groq's free tier is the cheapest way to transcribe: 2K requests/day and 28,800 audio
seconds/day (8 hours of audio) at no cost.
