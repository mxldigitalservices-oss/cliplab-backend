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
if [ -n "$FAKE_LOG" ]; then echo "$*" >> "$FAKE_LOG"; fi
case "$*" in
  *--list-formats*)
    echo "ID  EXT   RESOLUTION"
    echo "sb0 mhtml 48x27 storyboard"
    exit 0
    ;;
esac
bloqueo() { echo "ERROR: [youtube] abc: Sign in to confirm you're not a bot" >&2; exit 1; }
case "$MODO" in
  bot) bloqueo ;;
  botuna) if [ ! -f "$FAKE_COUNT" ]; then : > "$FAKE_COUNT"; bloqueo; fi ;;
  formato)
    case "$*" in
      *" -f "*)
        echo "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats" >&2
        exit 1
        ;;
    esac
    ;;
esac
if [ -n "$IMPRIMIR" ]; then
  DIR="$(dirname "$SALIDA")"
  mkdir -p "$DIR"
  echo x > "$DIR/vid123.mp4"
  echo "vid123|60|$DIR/vid123.mp4|Titulo de prueba"
else
  echo "vid123"
fi
