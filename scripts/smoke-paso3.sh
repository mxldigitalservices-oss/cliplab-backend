#!/bin/sh
set -e
mkdir -p media out/_smoke
ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440 -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac media/_smoke.mp4
cat << 'JSON' > out/_smoke/transcript.json
[
 {"text":"Esto","start":0.8,"end":1.2},{"text":"es","start":1.3,"end":1.5},{"text":"una","start":1.6,"end":1.9},
 {"text":"prueba","start":2.0,"end":2.6},{"text":"de","start":2.7,"end":2.9},{"text":"subtítulos","start":3.0,"end":3.7},
 {"text":"palabra","start":3.9,"end":4.4},{"text":"por","start":4.5,"end":4.7},{"text":"palabra.","start":4.8,"end":5.4},
 {"text":"Listo!","start":5.8,"end":6.3}
]
JSON
cat << 'JSON' > out/_smoke/clips.json
[{"id":1,"start":0.5,"end":7,"duration":6.5,"score":50,"title":"Prueba de subtítulos","keywords":["prueba","video"]}]
JSON
node scripts/paso3.mjs media/_smoke.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 out/_smoke/final/clip_01_prueba-de-subtitulos.mp4
