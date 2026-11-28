// ---------------------------------------------------------------------------
// Estado de las conexiones oficiales de Meta (Instagram Graph API + reenvio a Facebook) para la pestana Conexiones.
//  - Verifica el token REAL (GET /{IG_USER_ID}) sin publicar nada y deja el resultado en `conexion.oficial` de las
//    tarjetas de Instagram y Facebook. Las cookies siguen funcionando como respaldo y no se tocan.
//  - IMPORTANTE: Meta no expone por API si "enviar automaticamente a Facebook" esta activo en Accounts Center. Por eso
//    `crosspost_facebook` refleja lo que el operador declara con IG_CROSSPOST_FACEBOOK=on (y solo si Instagram esta conectado).
//    `crosspost_facebook_verificado` es siempre false.
// ---------------------------------------------------------------------------
import { store } from '../storage/store.js';
import { logger } from '../utils/logger.js';
import cliente, { crosspostFacebookActivo, instagramConfigurado } from './instagramPublisher.js';

export function crearSincronizadorMeta({ api = cliente, almacen = store, env = process.env, configurado = instagramConfigurado, crosspost = () => crosspostFacebookActivo() } = {}) {
  let ultimo = null;
  let temporizador = null;

  async function sincronizar() {
    const hayConfig = configurado();
    const ig = await api.verifyInstagramConnection();
    const crossActivo = Boolean(ig.connected && crosspost());
    const verificadoEn = ig.verificadoEn;

    if (!hayConfig) {
      almacen.actualizarConexion('instagram', { oficial: null });
      almacen.actualizarConexion('facebook', { oficial: null });
    } else {
      almacen.actualizarConexion('instagram', {
        oficial: ig.connected
          ? { metodo: 'graph_api', conectado: true, cuenta: ig.username ? '@' + ig.username : null, foto: ig.profile_picture_url || null, expiraEn: ig.token ? ig.token.expiraEn : null, diasRestantes: ig.token ? ig.token.diasRestantes : null, verificadoEn }
          : { metodo: 'graph_api', conectado: false, error: ig.error ? ig.error.mensaje : 'Sin conexion', codigo: ig.error ? ig.error.codigo : null, verificadoEn },
      });
      almacen.actualizarConexion('facebook', {
        oficial: crossActivo
          ? { metodo: 'crosspost', conectado: true, cuenta: ig.username ? 'Se publica desde @' + ig.username : 'Se publica desde Instagram', verificado: false, verificadoEn }
          : null,
      });
    }

    ultimo = {
      success: true,
      connected: Boolean(ig.connected),
      username: ig.username || null,
      crosspost_facebook: crossActivo,
      crosspost_facebook_verificado: false,
      instagram: { ...ig },
      facebook: { metodo: crossActivo ? 'crosspost' : 'cookies', crosspost_facebook: crossActivo, verificado: false },
      configurado: hayConfig,
      verificadoEn,
    };
    ultimo.data = { ...ultimo };   // el envelope respeta respuestas con `success`: aqui van ambas formas (plana y en data)
    ultimo.error = null;
    return ultimo;
  }

  function iniciar({ cadaMin = Number(env.META_VERIFICAR_MIN) || 30 } = {}) {
    if (temporizador) return;
    const ciclo = () => sincronizar().catch((error) => logger.warn('No se pudo verificar la conexion con Meta', { mensaje: error.message }));
    ciclo();
    temporizador = setInterval(ciclo, Math.max(5, cadaMin) * 60 * 1000);
    temporizador.unref?.();
  }
  function detener() { clearInterval(temporizador); temporizador = null; }

  return { sincronizar, iniciar, detener, ultimo: () => ultimo };
}

export const sincronizadorMeta = crearSincronizadorMeta();
