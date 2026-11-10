import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractAudio } from './audio.mjs';
import { transcribe } from './transcribe.mjs';
import { buildSentences } from './segmenter.mjs';
import { selectClips } from './selector.mjs';

export async function processVideo(inputPath, opts = {}) {
  const name = path.parse(inputPath).name;
  const outDir = path.resolve(opts.outDir || 'out', name);
  await mkdir(outDir, { recursive: true });

  const wav = path.join(outDir, 'audio.wav');
  console.log('[1/4] Extrayendo audio...');
  await extractAudio(inputPath, wav);

  console.log('[2/4] Transcribiendo en local (whisper.cpp)...');
  const words = await transcribe(wav, path.join(outDir, 'whisper'), { lang: opts.lang });
  await writeFile(path.join(outDir, 'transcript.json'), JSON.stringify(words, null, 2));

  console.log('[3/4] Segmentando oraciones...');
  const sentences = buildSentences(words);

  console.log('[4/4] Seleccionando clips...');
  const clips = selectClips(sentences, words, opts.select || {});
  await writeFile(path.join(outDir, 'clips.json'), JSON.stringify(clips, null, 2));

  await rm(wav, { force: true });
  console.log(`Listo: ${words.length} palabras, ${sentences.length} oraciones, ${clips.length} clips -> ${outDir}`);
  return { words, sentences, clips, outDir };
}
