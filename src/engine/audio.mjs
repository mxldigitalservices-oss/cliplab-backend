import { spawn } from 'node:child_process';

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} salió con código ${code}\n${err.slice(-1500)}`));
    });
  });
}

export async function extractAudio(inputPath, wavPath) {
  await run('ffmpeg', [
    '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath,
  ]);
  return wavPath;
}
