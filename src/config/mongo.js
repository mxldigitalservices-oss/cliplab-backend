// ---------------------------------------------------------------------------
// Resolucion de la conexion a MongoDB para el programador (cola de publicaciones).
//
// Railway no usa el nombre MONGODB_URI: el plugin de MongoDB expone MONGO_URL (red interna), MONGO_PUBLIC_URL (proxy
// publico) y las piezas MONGOHOST / MONGOPORT / MONGOUSER / MONGOPASSWORD. Antes el programador solo leia MONGODB_URI,
// asi que con el plugin conectado quedaba sin URI, caia al respaldo JSON y la barra decia "MongoDB: sin conexion".
//
// Prioridad: MONGODB_URI > MONGODB_URL > MONGO_URL > MONGO_PUBLIC_URL > armada con MONGOHOST/MONGOUSER/MONGOPASSWORD.
// Nombre de la base: MONGODB_DB > MONGO_DB > el de la URI > "cliplab" (la URL de Railway no trae base y el driver usaria "test").
// ---------------------------------------------------------------------------

const CANDIDATAS = ['MONGODB_URI', 'MONGODB_URL', 'MONGO_URL', 'MONGO_PUBLIC_URL'];
const BD_DEFECTO = 'cliplab';
const INVISIBLES = /[\u200B-\u200D\u2060\uFEFF]/g;

function limpiar(valor) {
  let v = String(valor ?? '').replace(INVISIBLES, '').trim();
  const c = v.charAt(0);
  if (v.length >= 2 && (c === '"' || c === "'") && v.endsWith(c)) v = v.slice(1, -1).trim();
  return v;
}

/** URI con las credenciales ocultas, segura para logs y respuestas de la API. */
export function mascararUri(uri) {
  return String(uri || '').replace(/^(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, '$1***@');
}

function nombreBdDeUri(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i.exec(uri);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ uri: string, fuente: string|null, nombreBd: string, problema: string|null }}
 *   uri '' = no configurada (el programador usa el respaldo JSON); `problema` explica por que no se pudo usar lo que habia.
 */
export function resolverMongo(env = process.env) {
  let problema = null;
  for (const nombre of CANDIDATAS) {
    const uri = limpiar(env[nombre]);
    if (!uri) continue;
    if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
      problema = nombre + ' no empieza por mongodb:// ni mongodb+srv:// (revisa el valor en Railway: sin comillas, sin espacios)';
      continue;
    }
    return { uri, fuente: nombre, nombreBd: limpiar(env.MONGODB_DB) || limpiar(env.MONGO_DB) || nombreBdDeUri(uri) || BD_DEFECTO, problema: null };
  }

  const host = limpiar(env.MONGOHOST);
  if (host) {
    const usuario = limpiar(env.MONGOUSER);
    const clave = limpiar(env.MONGOPASSWORD);
    const puerto = limpiar(env.MONGOPORT) || '27017';
    const credenciales = usuario ? encodeURIComponent(usuario) + (clave ? ':' + encodeURIComponent(clave) : '') + '@' : '';
    return {
      uri: 'mongodb://' + credenciales + host + ':' + puerto,
      fuente: 'MONGOHOST/MONGOUSER/MONGOPASSWORD',
      nombreBd: limpiar(env.MONGODB_DB) || limpiar(env.MONGO_DB) || BD_DEFECTO,
      problema,
    };
  }
  return { uri: '', fuente: null, nombreBd: limpiar(env.MONGODB_DB) || limpiar(env.MONGO_DB) || BD_DEFECTO, problema };
}
