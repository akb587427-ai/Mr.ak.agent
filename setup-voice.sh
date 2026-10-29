#!/usr/bin/env bash
# Installs the free, keyless voice engine.
#
# Speaking uses Microsoft Edge's read-aloud voices through edge-tts: no API key, no
# quota, no cost. This is the only speech component the agent needs; transcription
# uses the configured API key instead.
set -u

if python3 -c 'import edge_tts' 2>/dev/null; then
  echo "edge-tts already installed"
  exit 0
fi

# Some images mark the system Python as externally managed, which makes a plain
# install fail, so fall back to the override those images expect.
if ! pip install --quiet edge-tts 2>/dev/null; then
  echo "Retrying install with --break-system-packages"
  pip install --quiet --break-system-packages edge-tts || exit 1
fi

python3 -c 'import edge_tts' && echo "edge-tts installed"
