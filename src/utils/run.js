import { spawn } from 'node:child_process';

const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 256 * 1024;
const MAX_DETALLE = 64 * 1024;

/** Ultimas lineas utiles de stderr (max. ~1500 caracteres) para guardarlas como detalle tecnico. */
export function resumirStderr(stderr, max = 1500) {
  const texto = String(stderr || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-15).join('\n');
  return texto.length > max ? '...' + texto.slice(-max) : texto;
}

/** stderr completo para la pestana de Incidencias (solo se recorta al limite de seguridad, conservando el final). */
export function stderrCompleto(stderr, max = MAX_DETALLE) {
  const texto = String(stderr || '').replace(/\r/g, '\n').split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n');
  return texto.length > max ? '[... recortado ...]\n' + texto.slice(-max) : texto;
}

/** Detalle tecnico de CUALQUIER error: stderr del comando si lo hay; si no, la traza de JavaScript. */
export function detalleDeError(error) {
  if (!error) return '';
  const propio = error.detalle || stderrCompleto(error.stderr);
  if (propio) return propio;
  return stderrCompleto(error.stack || error.message || String(error));
}

export class ComandoError extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje);
    this.name = 'ComandoError';
    this.codigo = detalle.codigo ?? null;
    this.senal = detalle.senal ?? null;
    this.stderr = detalle.stderr ?? '';
  }
}

function crearDivisorDeLineas(callback) {
  let pendiente = '';
  return {
    escribir(fragmento) {
      pendiente += fragmento;
      const partes = pendiente.split(/\r\n|\n|\r/);
      pendiente = partes.pop();
      for (const linea of partes) {
        if (linea) callback(linea);
      }
    },
    cerrar() {
      if (pendiente) callback(pendiente);
      pendiente = '';
    },
  };
}

export function run(comando, args, opciones = {}) {
  const { timeoutMs = 0, cwd, signal, onStdoutLine, onStderrLine } = opciones;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new ComandoError('Proceso cancelado'));
      return;
    }

    let hijo;
    try {
      hijo = spawn(comando, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ComandoError('No se pudo iniciar ' + comando + ': ' + error.message));
      return;
    }

    let stdout = '';
    let stderr = '';
    let terminado = false;
    let vencido = false;
    let cancelado = false;
    let temporizador = null;

    const lineasOut = onStdoutLine ? crearDivisorDeLineas(onStdoutLine) : null;
    const lineasErr = onStderrLine ? crearDivisorDeLineas(onStderrLine) : null;

    const detener = () => {
      hijo.kill('SIGTERM');
      setTimeout(() => hijo.kill('SIGKILL'), 3000).unref();
    };

    const alAbortar = () => {
      cancelado = true;
      detener();
    };

    const limpiar = () => {
      clearTimeout(temporizador);
      if (signal) signal.removeEventListener('abort', alAbortar);
    };

    if (timeoutMs > 0) {
      temporizador = setTimeout(() => {
        vencido = true;
        detener();
      }, timeoutMs);
    }
    if (signal) signal.addEventListener('abort', alAbortar, { once: true });

    hijo.stdout.setEncoding('utf8');
    hijo.stderr.setEncoding('utf8');

    hijo.stdout.on('data', (fragmento) => {
      if (stdout.length < MAX_STDOUT) stdout += fragmento;
      if (lineasOut) lineasOut.escribir(fragmento);
    });

    hijo.stderr.on('data', (fragmento) => {
      stderr = (stderr + fragmento).slice(-MAX_STDERR);
      if (lineasErr) lineasErr.escribir(fragmento);
    });

    hijo.on('error', (error) => {
      if (terminado) return;
      terminado = true;
      limpiar();
      reject(new ComandoError('No se pudo ejecutar ' + comando + ': ' + error.message));
    });

    hijo.on('close', (codigo, senal) => {
      if (terminado) return;
      terminado = true;
      limpiar();
      if (lineasOut) lineasOut.cerrar();
      if (lineasErr) lineasErr.cerrar();

      if (codigo === 0) {
        resolve({ stdout, stderr });
        return;
      }

      let motivo = comando + ' termino con codigo ' + (codigo === null ? senal : codigo);
      if (vencido) motivo = comando + ' excedio el tiempo maximo de ' + timeoutMs + ' ms';
      if (cancelado) motivo = 'Proceso cancelado';
      reject(new ComandoError(motivo, { codigo, senal, stderr }));
    });
  });
}
