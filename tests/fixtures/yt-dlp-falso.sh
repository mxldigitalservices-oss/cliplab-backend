#!/bin/sh
MODO="${FAKE_MODE:-ok}"
CK=""
SALIDA=""
IMPRIMIR=""
ANT=""
for a in "$@"; do
  [ "$ANT" = "--cookies" ] && CK="$a"
  [ "$ANT" = "-o" ] && SALIDA="$a"
  case "$a" in after_move:*) IMPRIMIR="$a" ;; esac
  ANT="$a"
done
if [ -n "$CK" ]; then
  printf '.youtube.com\tTRUE\t/\tTRUE\t4102444800\t__Secure-1PSIDTS\tROTADA%s\n' "$(date +%s%N)" >> "$CK"
fi
bloqueo() { echo "ERROR: [youtube] abc: Sign in to confirm you're not a bot" >&2; exit 1; }
case "$MODO" in
  bot) bloqueo ;;
  botuna) if [ ! -f "$FAKE_COUNT" ]; then : > "$FAKE_COUNT"; bloqueo; fi ;;
esac
if [ -n "$IMPRIMIR" ]; then
  DIR="$(dirname "$SALIDA")"
  mkdir -p "$DIR"
  echo x > "$DIR/vid123.mp4"
  echo "vid123|60|$DIR/vid123.mp4|Titulo de prueba"
else
  echo "vid123"
fi
