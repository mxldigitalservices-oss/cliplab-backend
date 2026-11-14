import { leerLlave } from './api.js';

const $ = (id) => document.getElementById(id);
const ETIQUETAS = {
  activa: ['Activa', 'ses-ok'],
  bloqueada: ['Bloqueada', 'ses-err'],
  sin_sesion: ['Sin sesion', 'ses-neutro'],
  sin_verificar: ['Sin verificar', 'ses-warn'],
};

let temporizador = null;

function fecha(iso) {
  if (!iso) return 'nunca';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'nunca' : d.toLocaleString('es-DO');
}

async function pedir(metodo, sub = '', cuerpo) {
  const cabeceras = { Accept: 'application/json' };
  const llave = leerLlave();
  if (llave) cabeceras['x-master-key'] = llave;
  if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';

  let respuesta;
  try {
    respuesta = await fetch('/api/panel/sesion' + sub, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new Error('Sin conexion con el servidor');
  }

  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null;
  }
  if (respuesta.status === 401) {
    throw new Error('Falta la llave maestra: guardala en el panel (boton Llave) y vuelve aqui.');
  }
  if (!respuesta.ok) {
    throw new Error((datos && datos.error) || 'Error ' + respuesta.status);
  }
  return datos;
}

function pintar(e) {
  const [texto, clase] = ETIQUETAS[e.estado] || [e.estado, 'ses-neutro'];
  const badge = $('s-badge');
  badge.textContent = e.verificando ? texto + ' (verificando...)' : texto;
  badge.className = 'ses-badge ' + clase;

  $('s-detalle').textContent = e.detalle || '';
  $('s-cookies').textContent = e.cookies ? e.cookies.total + ' cookies en ' + e.cookies.dominios + ' dominios' : '-';
  $('s-vence').textContent = e.cookies && e.cookies.venceAuth ? fecha(e.cookies.venceAuth) : '-';
  $('s-verif').textContent = fecha(e.ultimaVerificacion);
  $('s-renov').textContent = fecha(e.ultimaRenovacion);
  $('s-persist').textContent = e.persistente ? 'Persistente (volumen)' : 'Temporal: se pierde al redesplegar';

  const avisos = [];
  if (!e.claveConfigurada) avisos.push('Falta SESSION_KEY (o MASTER_KEY) en el servidor: no se puede guardar la sesion.');
  if (e.claveConfigurada && !e.persistente) avisos.push('La sesion se guarda en almacenamiento temporal. Monta un volumen en Railway o define SESSION_DIR.');
  const aviso = $('s-aviso');
  aviso.hidden = avisos.length === 0;
  aviso.textContent = avisos.join(' ');
}

async function cargar() {
  clearTimeout(temporizador);
  let espera = 20000;
  try {
    const estado = await pedir('GET');
    pintar(estado);
    if (estado.verificando) espera = 3000;
  } catch (error) {
    $('s-msg').textContent = error.message;
  }
  temporizador = setTimeout(cargar, espera);
}

function mensaje(texto) {
  $('s-msg').textContent = texto;
}

$('b-guardar').addEventListener('click', async () => {
  const campo = $('t-cookies');
  const valor = campo.value.trim();
  if (!valor) {
    mensaje('Pega primero el contenido de cookies.txt o el JSON.');
    return;
  }
  $('b-guardar').disabled = true;
  try {
    const r = await pedir('POST', '', { cookies: valor });
    campo.value = '';
    mensaje('Guardadas ' + r.cookies.total + ' cookies. Verificando...');
    cargar();
  } catch (error) {
    mensaje(error.message);
  } finally {
    $('b-guardar').disabled = false;
  }
});

$('b-verificar').addEventListener('click', async () => {
  try {
    await pedir('POST', '/verificar');
    mensaje('Verificacion en curso...');
    cargar();
  } catch (error) {
    mensaje(error.message);
  }
});

$('b-borrar').addEventListener('click', async () => {
  if (!window.confirm('Se borrara la sesion guardada. Continuar?')) return;
  try {
    await pedir('DELETE');
    mensaje('Sesion borrada.');
    cargar();
  } catch (error) {
    mensaje(error.message);
  }
});

cargar();
