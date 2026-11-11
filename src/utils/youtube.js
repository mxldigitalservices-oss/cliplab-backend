const HOSTS_YOUTUBE = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

export function parsearUrlYoutube(entrada) {
  let parsed;
  try {
    parsed = new URL(String(entrada ?? '').trim());
  } catch {
    return null;
  }

  const protocoloValido = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  if (!protocoloValido || !HOSTS_YOUTUBE.has(parsed.hostname.toLowerCase())) {
    return null;
  }
  return parsed;
}

function aSegundos(valor) {
  const texto = String(valor || '').trim().toLowerCase();
  if (!texto) return 0;
  if (/^\d+$/.test(texto)) return parseInt(texto, 10);

  const partes = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(texto);
  if (!partes) return 0;
  return Number(partes[1] || 0) * 3600 + Number(partes[2] || 0) * 60 + Number(partes[3] || 0);
}

export function segundosDesdeUrl(parsed) {
  return aSegundos(parsed.searchParams.get('t') || parsed.searchParams.get('start'));
}
