FROM node:24-bookworm-slim

# curl, procps (pgrep/pkill), iproute2 (ss) and tini are what the watchdog needs:
# the first three to judge health and to stop a wedged process, the last to reap the
# processes it restarts. The slim image ships none of them.
# ffmpeg converts speech to the OGG/Opus container WhatsApp plays as a voice note, and
# python3 with edge-tts produces the free, keyless voice itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl procps iproute2 tini ca-certificates ffmpeg python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The image marks its Python as externally managed, so setup-voice.sh installs edge-tts
# with the override that layout expects.
RUN bash setup-voice.sh

# The WhatsApp session, config and chat history have to outlive a redeploy, so they
# are read from a mounted volume instead of the container filesystem. Both variables
# are needed: DATA_DIR covers config/history/leads, AUTH_DIR the Baileys session.
ENV DATA_DIR=/data
ENV AUTH_DIR=/data/auth
VOLUME /data

# Send the watchdog's own lines and the app's output to stdout, which is where the
# platform collects logs. Without this they would only exist inside the container.
ENV LOG_STDOUT=1

EXPOSE 12000

# The watchdog is the entrypoint rather than node itself so that a process which is
# alive but no longer answering is recovered too; a platform restart policy only sees
# a process that exits. tini reaps the processes the watchdog restarts, which bash
# does not do when it runs as PID 1.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "watchdog.sh"]
