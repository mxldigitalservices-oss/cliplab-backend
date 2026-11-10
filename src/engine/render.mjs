import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildAss, clipWords } from './ass.mjs';

function ff(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} salió con código ${code}\n${err.slice(-1500)}`));
    });
  });
}

async function preflight() {
  const out = await ff('ffmpeg', ['-hide_banner', '-filters']);
  if (!/^\s*\S+\s+ass\s+/m.test(out)) {
    throw new Error('Este FFmpeg no tiene el filtro "ass" (libass). Usa la imagen Docker del engine.');
  }
}

function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clip';
}

export async function renderAll(videoPath, opts = {}) {
  await preflight();

  const video = path.resolve(videoPath);
  const name = path.parse(video).name;
  const base = path.resolve(opts.outDir || 'out', name);
  const words = JSON.parse(await readFile(path.join(base, 'transcript.json'), 'utf8'));
  let clips = JSON.parse(await readFile(path.join(base, 'clips.json'), 'utf8'));
  if (opts.only && opts.only.length) clips = clips.filter((c) => opts.only.includes(c.id));

  const finalDir = path.join(base, 'final');
  await mkdir(finalDir, { recursive: true });

  const focus = Math.min(1, Math.max(0, Number(opts.focus ?? 0.5)));
  const crf = String(opts.crf || 20);
  const preset = opts.preset || 'veryfast';
  const threads = String(opts.threads || process.env.FFMPEG_THREADS || 0);
  const manifest = [];

  for (const clip of clips) {
    const tag = String(clip.id).padStart(2, '0');
    const assName = `clip_${tag}.ass`;
    const outName = `clip_${tag}_${slug(clip.title)}.mp4`;
    const dur = clip.end - clip.start;

    await writeFile(path.join(finalDir, assName), buildAss(clipWords(words, clip), clip, opts.sub || {}));

    const vf = [
      `crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='(iw-out_w)*${focus}':y='(ih-out_h)/2'`,
      'scale=1080:1920:flags=lanczos',
      'setsar=1',
      `ass=${assName}`,
    ].join(',');

    console.log(`[clip ${tag}] ${clip.start}s -> ${clip.end}s  "${clip.title}"`);
    await ff('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(clip.start), '-i', video, '-t', dur.toFixed(2),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p', '-threads', threads,
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      outName,
    ], finalDir);

    manifest.push({
      id: clip.id,
      file: outName,
      subtitles: assName,
      start: clip.start,
      end: clip.end,
      duration: Math.round(dur * 100) / 100,
      score: clip.score,
      caption: clip.title,
      hashtags: (clip.keywords || []).slice(0, 5).map((k) => `#${k}`),
    });
  }

  await writeFile(path.join(finalDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Listo: ${manifest.length} videos en ${finalDir}`);
  return { finalDir, manifest };
}
