const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { run } = require('./proc');

const safeId = (id) => String(id).replace(/[^\w-]/g, '_');

function baseArgs() {
  const a = ['--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '3'];
  if (cfg.ytdlpCookies && fs.existsSync(cfg.ytdlpCookies)) a.push('--cookies', cfg.ytdlpCookies);
  return a;
}

async function metadata(url) {
  const { stdout } = await run(cfg.ytdlpBin, [...baseArgs(), '-J', '--skip-download', '--', url], {
    timeoutMs: 120000,
  });
  const j = JSON.parse(stdout);
  return {
    id: safeId(j.id),
    titulo: j.title || 'Sin título',
    duracion: Number(j.duration) || null,
    descripcion: j.description || '',
    tags: Array.isArray(j.tags) ? j.tags : [],
    capitulos: Array.isArray(j.chapters) ? j.chapters : [],
  };
}

async function subtitulos(url, id) {
  try {
    await run(
      cfg.ytdlpBin,
      [
        ...baseArgs(),
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', cfg.subLangs,
        '--sub-format', 'vtt',
        '-o', path.join(cfg.tmpDir, `${id}.%(ext)s`),
        '--', url,
      ],
      { timeoutMs: 120000 }
    );
  } catch (err) {
    console.warn(`[ytdlp] subtítulos no disponibles (${id}): ${err.message}`);
  }
  const files = fs.readdirSync(cfg.tmpDir).filter((f) => f.startsWith(`${id}.`) && f.endsWith('.vtt'));
  if (!files.length) return { texto: null, archivos: [] };
  const archivos = files.map((f) => path.join(cfg.tmpDir, f));
  return { texto: fs.readFileSync(archivos[0], 'utf8'), archivos };
}

async function descargar(url, id) {
  await run(
    cfg.ytdlpBin,
    [
      ...baseArgs(),
      '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
      '--merge-output-format', 'mp4',
      '-o', path.join(cfg.tmpDir, `${id}.%(ext)s`),
      '--', url,
    ],
    { timeoutMs: 30 * 60 * 1000 }
  );
  const f = fs
    .readdirSync(cfg.tmpDir)
    .find((n) => n.startsWith(`${id}.`) && !/\.(vtt|part|ytdl)$/.test(n));
  if (!f) throw new Error('yt-dlp no produjo el archivo de video');
  return path.join(cfg.tmpDir, f);
}

function limpiar(id) {
  try {
    for (const f of fs.readdirSync(cfg.tmpDir)) {
      if (f.startsWith(`${id}.`)) fs.unlinkSync(path.join(cfg.tmpDir, f));
    }
  } catch (_) {}
}

module.exports = { metadata, subtitulos, descargar, limpiar };
