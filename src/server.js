import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { verificarHerramientas } from './engine/herramientas.js';
import { detenerCola } from './engine/cola.js';
import { iniciarVigilancia, detenerVigilancia } from './sesion/gestor.js';
import { store } from './storage/store.js';
import { detalleDeError } from './utils/run.js';

async function main() {
  await fs.mkdir(config.tmpDir, { recursive: true });
  await fs.mkdir(config.clipsDir, { recursive: true });
  await fs.rm(path.join(config.tmpDir, 'jobs'), { recursive: true, force: true });
  // Cookies descifradas que pudieron quedar de una ejecucion anterior interrumpida.
  await fs.rm(path.join(config.tmpDir, 'sesion'), { recursive: true, force: true });

  if (!config.sessionKey) {
    logger.warn('Sin SESSION_KEY ni MASTER_KEY: no se podra guardar la sesion de YouTube');
  }

  const herramientas = await verificarHerramientas();
  for (const [nombre, estado] of Object.entries(herramientas)) {
    if (estado.available) {
      logger.info('Herramienta disponible', { nombre, ...estado });
    } else {
      logger.warn('Herramienta no disponible', { nombre, error: estado.error });
    }
  }

  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    logger.info('ClipLab Pro escuchando', {
      host: config.host,
      port: config.port,
      env: config.env,
    });
    iniciarVigilancia();
  });

  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Senal recibida, cerrando servidor', { signal });
    detenerVigilancia();
    detenerCola();

    server.close((error) => {
      if (error) {
        logger.error('Error cerrando servidor', error);
        process.exit(1);
      }
      logger.info('Servidor cerrado correctamente');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Cierre forzado por timeout');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection', error);
    store.registrarIncidencia('error', 'Promesa rechazada sin controlar: ' + error.message, 'proceso', detalleDeError(error));
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaughtException', error);
    store.registrarIncidencia('error', 'Excepcion no controlada: ' + error.message, 'proceso', detalleDeError(error));
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  logger.error('Fallo fatal al iniciar', error);
  process.exit(1);
});
