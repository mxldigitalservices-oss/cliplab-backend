import { spawn } from 'node:child_process';
import { config } from '../config/index.js';

export function checkFfmpeg() {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(config.ffmpegPath, ['-version']);
    } catch (error) {
      finish({ available: false, version: null, error: error.message });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ available: false, version: null, error: 'Timeout verificando FFmpeg' });
    }, 5000);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ available: false, version: null, error: error.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const firstLine = output.split('\n')[0] || '';
        finish({ available: true, version: firstLine.trim(), error: null });
      } else {
        finish({ available: false, version: null, error: 'FFmpeg salio con codigo ' + code });
      }
    });
  });
}
