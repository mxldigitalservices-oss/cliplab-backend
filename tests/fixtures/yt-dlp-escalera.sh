#!/bin/sh
# yt-dlp falso para probar la escalera de estrategias. Registra cada llamada en $FAKE_LOG.
#   FAKE_REQUIERE: texto que deben contener los argumentos para que la descarga funcione (vacio = siempre funciona)
#   FAKE_ERROR:    mensaje de error a imprimir cuando no funciona (por defecto: formato no disponible)
LISTA=""; SALIDA=""; IMPRIMIR=""; TODOS="$*"
for a in "$@"; do
  [ "$a" = "--list-formats" ] && LISTA=1
  case "$a" in after_move:*) IMPRIMIR="$a" ;; esac
done
ANT=""
for a in "$@"; do [ "$ANT" = "-o" ] && SALIDA="$a"; ANT="$a"; done
echo "$TODOS" >> "$FAKE_LOG"

if [ -n "$LISTA" ]; then
  echo "ID  EXT  RESOLUTION"
  echo "sb0 mhtml 48x27  storyboard"
  exit 0
fi
if [ -n "$FAKE_REQUIERE" ]; then
  case "$TODOS" in
    *"$FAKE_REQUIERE"*) ;;
    *) echo "${FAKE_ERROR:-ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats}" >&2; exit 1 ;;
  esac
fi
DIR="$(dirname "$SALIDA")"; mkdir -p "$DIR"; echo x > "$DIR/vid123.mp4"
echo "vid123|60|$DIR/vid123.mp4|Titulo de prueba"
