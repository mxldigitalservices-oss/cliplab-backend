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

export function tieneCredencialesFacebookMeta(env = process.env) {
  return Boolean(String(env.FB_PAGE_ACCESS_TOKEN || "").trim() && String(env.FB_PAGE_ID || "").trim());
}

async function verificarUrlVideoDisponible(videoUrl, fetchFn) {
  if (!videoUrl || typeof fetchFn !== "function") return false;
  try {
    let res = await fetchFn(videoUrl, { method: "HEAD" });
    if (res && (res.status === 405 || res.status === 501)) {
      res = await fetchFn(videoUrl, { method: "GET", headers: { Range: "bytes=0-1024" } });
    }
    if (!res || !res.ok) return false;
    const len = Number(res.headers?.get?.("content-length") || 0);
    if (res.headers?.get?.("content-length") !== null && len === 0) return false;
    return true;
  } catch {
    return false;
  }
}

export async function publicarVideoFacebookMeta(clip, opts = {}) {
  const env = opts.env || process.env;
  const fetchFn = opts.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("FETCH_NO_DISPONIBLE: no hay funcion fetch disponible");
  }
  const accessToken = String(env.FB_PAGE_ACCESS_TOKEN || "").trim();
  const pageId = String(env.FB_PAGE_ID || "").trim();
  if (!accessToken || !pageId) {
    throw new Error("FB_CREDENCIALES_FALTANTES: faltan FB_PAGE_ACCESS_TOKEN o FB_PAGE_ID");
  }
  if (clip && (clip.activo === false || clip.estado === "inactivo" || clip.retirado === true)) {
    throw new Error("FB_CLIP_NO_ACTIVO: el clip seleccionado no esta activo");
  }
  const videoUrl = resolverUrlPublicaClip(clip, env);
  if (!videoUrl) {
    throw new Error("FB_SIN_URL_PUBLICA: se requiere urlPublica/url HTTPS o RAILWAY_PUBLIC_DOMAIN + archivo/rutaVideo");
  }
  const disponible = await verificarUrlVideoDisponible(videoUrl, fetchFn);
  if (!disponible) {
    throw new Error(`FB_VIDEO_INACTIVO_O_NO_DISPONIBLE: no hay archivo activo accesible en ${videoUrl}`);
  }
  const description = String(opts.texto ?? clip.texto ?? clip.caption ?? clip.descripcion ?? clip.titulo ?? "").trim();
  const title = String(clip.titulo || clip.title || "").trim();
  const params = new URLSearchParams({
    file_url: videoUrl,
    access_token: accessToken,
  });
  if (description) params.set("description", description);
  if (title) params.set("title", title);

  const res = await fetchFn(`${GRAPH_BASE}/${encodeURIComponent(pageId)}/videos`, {
    method: "POST",
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(`FB_PUBLICAR_ERROR (${res.status}): ${JSON.stringify(data)}`);
  }
  return {
    ok: true,
    red: "facebook",
    canal: "graph_api",
    videoId: data.id,
    pageId,
    videoUrl,
  };
}
