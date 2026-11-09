const express = require('express');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const db = require('./db');
const queue = require('./queue');
const routes = require('./routes');

process.on('unhandledRejection', (e) => console.error('[proceso] unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('[proceso] uncaughtException:', e));

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, noarchive');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', routes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));
app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

async function main() {
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  fs.mkdirSync(cfg.exportDir, { recursive: true });
  await db.migrate();
  await queue.recuperarHuerfanos(true);
  queue.iniciar();

  const server = app.listen(cfg.port, '0.0.0.0', () => console.log(`[http] escuchando en :${cfg.port}`));

  const apagar = async (sig) => {
    console.log(`[proceso] ${sig} recibido, cerrando...`);
    server.close();
    await queue.detener();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));
}

main().catch((e) => {
  console.error('[arranque] fallo fatal:', e);
  process.exit(1);
});
