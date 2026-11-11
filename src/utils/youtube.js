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
