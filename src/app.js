import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import routes from './routes/index.js';
import { envelope } from './middleware/envelope.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(cors({ origin: config.corsOrigin }));
  // El envelope va ANTES de express.json: un JSON malformado lanza su error dentro del parser, y la
  // respuesta de error tambien debe salir como { success:false, data:null, error }.
  app.use('/api', envelope);
  app.use(express.json({ limit: '1mb' }));

  app.use('/clips', express.static(config.clipsDir, { index: false, dotfiles: 'ignore', maxAge: '1d' }));
  app.use(express.static(publicDir, { etag: true }));
  app.use(routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
