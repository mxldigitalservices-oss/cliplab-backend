function norm(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function diff1(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else { if (++d > 1) return false; if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; } }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}

function matchTerm(term, todo, palabras) {
  if (!term) return { ok: true, peso: 0 };
  if (todo.includes(term)) return { ok: true, peso: 2 };
  if (term.length >= 5 && palabras.some((p) => diff1(term, p))) return { ok: true, peso: 1 };
  return { ok: false, peso: 0 };
}

function fragmento(orig, terms) {
  const raw = String(orig || '').replace(/\s+/g, ' ').trim();
  if (!raw || !terms.length) return raw.slice(0, 140);
  const rn = norm(raw);
  for (const t of terms) {
    const pos = rn.indexOf(t);
    if (pos !== -1) {
      const ini = Math.max(0, pos - 35), fin = Math.min(raw.length, pos + t.length + 65);
      return (ini > 0 ? '…' : '') + raw.slice(ini, fin).trim() + (fin < raw.length ? '…' : '');
    }
  }
  return raw.slice(0, 140);
}

export function filtrarClipsFlujo(clips = [], filtros = {}) {
  const lista = Array.isArray(clips) ? clips : [];
  const f = filtros && typeof filtros === 'object' ? filtros : {};
  const terms = norm(f.q || f.busqueda || f.texto || '').split(' ').filter(Boolean);
  const estado = String(f.estado || '').trim().toLowerCase();
  const origen = String(f.origen || '').trim().toLowerCase();
  const proyecto = String(f.proyecto || '').trim().toLowerCase();
  const soloFav = Boolean(f.soloFavoritos || f.favoritos);
  const minScore = Number.isFinite(Number(f.puntajeMin)) ? Number(f.puntajeMin) : null;

  const out = [];
  for (const clip of lista) {
    if (!clip) continue;
    if (estado && estado !== 'todos' && String(clip.estado || '').toLowerCase() !== estado) continue;
    const esVivo = Boolean(clip.envivo || clip.origen === 'envivo' || clip.origen === 'live');
    if (origen && origen !== 'todos') {
      if (origen === 'envivo' && !esVivo) continue;
      if (origen === 'enlace' && esVivo) continue;
      if (!['envivo', 'enlace'].includes(origen) && String(clip.origen || '').toLowerCase() !== origen) continue;
    }
    if (proyecto && proyecto !== 'todos' && String(clip.proyectoId || clip.proyecto || '').toLowerCase() !== proyecto) continue;
    if (soloFav && !clip.favorito) continue;
    if (minScore !== null && Number(clip.puntaje ?? clip.score ?? clip.gancho ?? 0) < minScore) continue;

    const titulo = String(clip.ficha?.titulo || clip.marketing?.titulo || clip.titulo || '');
    const gancho = String(clip.gancho || clip.marketing?.gancho || '');
    const desc = String(clip.ficha?.descripcion || clip.marketing?.descripcion || clip.descripcion || '');
    const trans = String(clip.transcripcion || clip.texto || '');
    const tN = norm(titulo), gN = norm(gancho), dN = norm(desc), trN = norm(trans);
    const todo = [tN, gN, dN, trN].filter(Boolean).join(' ');
    const pals = todo.split(/[^a-z0-9]+/).filter(Boolean);

    let relevancia = 0, ok = true;
    for (const term of terms) {
      const m = matchTerm(term, todo, pals);
      if (!m.ok) { ok = false; break; }
      if (tN.includes(term)) relevancia += 10 * m.peso;
      else if (gN.includes(term)) relevancia += 6 * m.peso;
      else if (dN.includes(term)) relevancia += 4 * m.peso;
      else if (trN.includes(term)) relevancia += 3 * m.peso;
      else relevancia += m.peso;
    }
    if (!ok) continue;
    out.push({ ...clip, relevancia, contextoCoincidencia: terms.length ? fragmento(trans || desc || gancho || titulo, terms) : '' });
  }

  const orden = String(f.orden || 'relevancia').toLowerCase();
  out.sort((a, b) => {
    if (orden === 'reciente') return String(b.creadoEn || '').localeCompare(String(a.creadoEn || ''));
    if (orden === 'puntaje') return (Number(b.puntaje ?? b.score ?? 0) - Number(a.puntaje ?? a.score ?? 0)) || (b.relevancia - a.relevancia);
    return b.relevancia - a.relevancia;
  });
  return out;
}
