#!/bin/sh
# Arranque del contenedor: actualiza yt-dlp en segundo plano (YouTube cambia seguido) sin retrasar el servidor.
if [ -n "$YTDLP_PATH" ] && [ -x "$YTDLP_PATH" ]; then
  ( timeout 90 "$YTDLP_PATH" -U >/dev/null 2>&1 || true ) &
fi
exec node src/server.js
