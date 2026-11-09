const fs = require('fs');
const cfg = require('./config');
const { run } = require('./proc');

async function cortar({ entrada, inicio, duracion, salida }) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(Number(inicio).toFixed(2)),
    '-i', entrada,
    '-t', String(Number(duracion).toFixed(2)),
    '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    salida,
  ];
  try {
    await run(cfg.ffmpegBin, args, { timeoutMs: 10 * 60 * 1000 });
    const st = fs.statSync(salida);
    if (!st.size) throw new Error('ffmpeg generó un archivo vacío');
  } catch (err) {
    try { fs.unlinkSync(salida); } catch (_) {}
    throw err;
  }
}

module.exports = { cortar };
