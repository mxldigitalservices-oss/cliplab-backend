const { spawn } = require('child_process');

function run(cmd, args, { timeoutMs = 10 * 60 * 1000, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outSize = 0;
    let err = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      p.kill('SIGKILL');
      reject(new Error(`Tiempo agotado ejecutando ${cmd}`));
    }, timeoutMs);

    p.stdout.on('data', (d) => {
      outSize += d.length;
      if (outSize <= maxBytes) out.push(d);
    });
    p.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    p.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: err });
      reject(new Error(`${cmd} terminó con código ${code}: ${err.trim().slice(-600)}`));
    });
  });
}

module.exports = { run };
