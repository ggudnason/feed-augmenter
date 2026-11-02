#!/bin/sh
# macOS/Linux launcher. On macOS, double-click (run `chmod +x start.command` once).
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed: https://nodejs.org"; exit 1; }
node server.js --open
