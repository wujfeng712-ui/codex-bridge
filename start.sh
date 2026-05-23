#!/bin/bash
# Start codex-bridge proxy for DeepSeek API
# This bridges Codex CLI's Responses API to DeepSeek's Chat Completions API

cd "$(dirname "$0")"

# Check if already running
if lsof -ti:4000 >/dev/null 2>&1; then
    echo "codex-bridge is already running on port 4000 (PID: $(lsof -ti:4000))"
    exit 0
fi

# Start the proxy
echo "Starting codex-bridge on http://127.0.0.1:4000 ..."
node --env-file=.env proxy.mjs
