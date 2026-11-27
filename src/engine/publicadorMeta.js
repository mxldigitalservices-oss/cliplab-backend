const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tieneCredencialesMeta(env = process.env) {
  return Boolean(String(env.IG_ACCESS_TOKEN || '').trim() && String(env.IG_USER_ID || '').trim());
}

export function resolverUrlPublicaClip(clip = {}, env = process.env) {
  if (clip.urlPublica && /^https?:\/\//i.test(String(clip.urlPublica).trim())) {
    return String(clip.urlPublica).trim();
  }
  if (clip.url && /^https?:\/\//i.test(String(clip.url).trim())) {
    return String(clip.url).trim();
  }
  const rawBase =
    env.PUBLIC_BASE_URL ||
    env.APP_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  const base = String(rawBase || '').trim().replace(/\/+$/, '');
  const nombreArchivo = clip.archivo || (clip.rutaVideo ? String(clip.rutaVideo).split('/').pop() : '');
  if (!base || !nombreArchivo) return '';
  return `${base}/clips/${encodeURIComponent(nombreArchivo)}`;
}

export async function publicarReelInstagramMeta(clip, opts = {}) {
  const env = opts.env || process.env;
  const fetchFn = opts.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('FETCH_NO_DISPONIBLE: no hay función fetch disponible');
  }

  const accessToken = String(env.IG_ACCESS_TOKEN || '').trim();
  const igUserId = String(env.IG_USER_ID || '').trim();
  if (!accessToken || !igUserId) {
    throw new Error('META_CREDENCIALES_FALTANTES: faltan IG_ACCESS_TOKEN o IG_USER_ID');
  }

  const videoUrl = resolverUrlPublicaClip(clip, env);
  if (!videoUrl) {
    throw new Error('META_SIN_URL_PUBLICA: se requiere urlPublica/url HTTPS o RAILWAY_PUBLIC_DOMAIN + archivo/rutaVideo');
  }

  const caption = String(clip.caption ?? clip.texto ?? clip.descripcion ?? '').trim();
  const shareToFeed = opts.shareToFeed ?? (String(env.META_SHARE_TO_FEED || 'true').toLowerCase() !== 'false');

  const createParams = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: String(shareToFeed),
    access_token: accessToken,
  });

  const createRes = await fetchFn(`${GRAPH_BASE}/${encodeURIComponent(igUserId)}/media`, {
    method: 'POST',
    body: createParams,
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !createData.id) {
    throw new Error(`META_CONTENEDOR_ERROR (${createRes.status}): ${JSON.stringify(createData)}`);
  }

  const creationId = createData.id;
  const maxIntentos = opts.maxIntentos ?? 12;
  const intervaloMs = opts.intervaloMs ?? 1500;
  const waitFn = opts.sleepFn || sleep;

  let estado = 'IN_PROGRESS';
  for (let i = 0; i < maxIntentos; i += 1) {
    const statusUrl = `${GRAPH_BASE}/${encodeURIComponent(creationId)}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`;
    const stRes = await fetchFn(statusUrl);
    const stData = await stRes.json().catch(() => ({}));
    if (!stRes.ok) {
      throw new Error(`META_ESTADO_ERROR (${stRes.status}): ${JSON.stringify(stData)}`);
    }
    estado = String(stData.status_code || stData.status || '').toUpperCase();
    if (estado === 'FINISHED' || estado === 'PUBLISHED') break;
    if (estado === 'ERROR' || estado === 'EXPIRED') {
      throw new Error(`META_PROCESO_FALLIDO: estado=${estado} detalle=${JSON.stringify(stData)}`);
    }
    await waitFn(intervaloMs);
  }

  const publishParams = new URLSearchParams({
    creation_id: creationId,
    access_token: accessToken,
  });
  const pubRes = await fetchFn(`${GRAPH_BASE}/${encodeURIComponent(igUserId)}/media_publish`, {
    method: 'POST',
    body: publishParams,
  });
  const pubData = await pubRes.json().catch(() => ({}));
  if (!pubRes.ok || !pubData.id) {
    throw new Error(`META_PUBLICAR_ERROR (${pubRes.status}): ${JSON.stringify(pubData)}`);
  }

  return {
    ok: true,
    red: 'instagram',
    canal: 'graph_api',
    creationId,
    mediaId: pubData.id,
    videoUrl,
    shareToFeed,
    estadoFinal: estado,
  };
}
