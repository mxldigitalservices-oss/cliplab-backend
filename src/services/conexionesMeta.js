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
import clienteFb, { facebookDirectoForzado } from './facebookPublisher.js';

export function crearSincronizadorMeta({ api = cliente, apiFb = clienteFb, almacen = store, env = process.env, configurado = instagramConfigurado, crosspost = () => crosspostFacebookActivo(), directoForzado = () => facebookDirectoForzado() } = {}) {
  let ultimo = null;
  let temporizador = null;

  async function sincronizar() {
    const hayConfig = configurado();
    const fbConfig = apiFb.facebookConfigurado();
    const ig = await api.verifyInstagramConnection();
    const fb = fbConfig ? await apiFb.verifyFacebookConnection() : null;
    const crossActivo = Boolean(ig.connected && crosspost());
    const verificadoEn = ig.verificadoEn;

    almacen.actualizarConexion('instagram', {
      oficial: !hayConfig ? null : ig.connected
        ? { metodo: 'graph_api', conectado: true, cuenta: ig.username ? '@' + ig.username : null, foto: ig.profile_picture_url || null, expiraEn: ig.token ? ig.token.expiraEn : null, diasRestantes: ig.token ? ig.token.diasRestantes : null, verificadoEn }
        : { metodo: 'graph_api', conectado: false, error: ig.error ? ig.error.mensaje : 'Sin conexion', codigo: ig.error ? ig.error.codigo : null, verificadoEn },
    });
    // Facebook: la Pagina por API (FB_PAGE_*) manda sobre el reenvio de Instagram; sin ninguna de las dos, solo cookies.
    let ficha = null;
    if (fb) {
      ficha = fb.connected
        ? { metodo: 'pagina_api', conectado: true, cuenta: fb.name || ('Pagina ' + fb.id), crosspost: crossActivo && !directoForzado(), verificadoEn: fb.verificadoEn }
        : { metodo: 'pagina_api', conectado: false, error: fb.error ? fb.error.mensaje : 'Sin conexion', codigo: fb.error ? fb.error.codigo : null, verificadoEn: fb.verificadoEn };
    } else if (crossActivo) {
      ficha = { metodo: 'crosspost', conectado: true, cuenta: ig.username ? 'Se publica desde @' + ig.username : 'Se publica desde Instagram', verificado: false, verificadoEn };
    }
    almacen.actualizarConexion('facebook', { oficial: ficha });

    ultimo = {
      success: true,
      connected: Boolean(ig.connected),
      username: ig.username || null,
      crosspost_facebook: crossActivo,
      crosspost_facebook_verificado: false,
      instagram: { ...ig },
      facebook: {
        metodo: fb ? 'pagina_api' : (crossActivo ? 'crosspost' : 'cookies'),
        pagina_conectada: fb ? fb.connected : null,
        pagina: fb && fb.connected ? fb.name : null,
        pagina_error: fb && !fb.connected && fb.error ? fb.error : null,
        crosspost_facebook: crossActivo,
        verificado: false,
      },
      configurado: hayConfig,
      facebook_directo: Boolean(fb && fb.connected),
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
