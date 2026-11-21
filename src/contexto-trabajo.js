// Contexto del trabajo en curso (AsyncLocalStorage): la cola lo fija al ejecutar cada trabajo y el render lo lee,
// asi los ajustes del clip (velocidad, tono, espejo, logo...) llegan al FFmpeg sin cambiar la firma del pipeline.
import { AsyncLocalStorage } from 'node:async_hooks';

export const contextoTrabajo = new AsyncLocalStorage();
