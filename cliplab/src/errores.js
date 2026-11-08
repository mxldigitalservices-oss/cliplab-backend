// Error con código HTTP: el manejador de server.js ya lo respeta (e.status).
export class ErrorHttp extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}
