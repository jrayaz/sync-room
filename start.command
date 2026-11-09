#!/bin/bash
# macOS / Linux launcher. First time only: open Terminal in this folder and run:  chmod +x start.command
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installing dependencies, one moment..."
  npm install --omit=dev
fi
node server.js
