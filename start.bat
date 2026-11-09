@echo off
cd /d "%~dp0"
title Sync Room
if exist "runtime\node.exe" (
  rem Portable build: Node.js and every dependency are bundled, so nothing needs installing.
  "runtime\node.exe" server.js
) else (
  if not exist node_modules (
    echo Installing dependencies, one moment...
    call npm install --omit=dev
  )
  node server.js
)
pause