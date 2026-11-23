const MULETILLAS = new Set(['eh','este','bueno','o','sea','osea','mmm','mm','aja','ajá','verdad','claro','mira','oye','pues','entonces','como','que']);
const VACIAS = new Set(['el','la','los','las','un','una','unos','unas','de','del','al','y','e','o','u','en','por','para','con','sin','a','que','es','son','fue','era','se','su','sus','mi','mis','tu','tus','lo','le']);

export function limpiarTextoBase(t) {
  return String(t || '').replace(/\s+/g, ' ').replace(/^[\s"'“”«»\-–—:•]+|[\s"'“”«»\-–—:•]+$/g, '').trim();
}

export function cortarLimpio(t, max = 70) {
  const s = limpiarTextoBase(t);
  if (!s || s.length <= max) return s;
  const trozo = s.slice(0, max + 1);
  const idx = trozo.lastIndexOf(' ');
  return limpiarTextoBase(idx >= Math.floor(max * 0.55) ? trozo.slice(0, idx) : trozo.slice(0, max));
}

export function extraerFrasesFuertes(tr = '') {
  const crudo = String(tr || '').replace(/\s+/g, ' ').trim();
  if (!crudo) return [];
  return [...new Set(crudo.split(/(?<=[.!?…])\s+|\s*[|•]\s*|\s+-\s+/).map(limpiarTextoBase).filter((p) => p.length >= 12))];
}

function claves(t) {
  return limpiarTextoBase(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !VACIAS.has(w));
}

export function puntuarTitulo(cand, { transcripcion = '', queBuscar = '' } = {}) {
  const texto = limpiarTextoBase(cand);
  if (!texto) return { texto: '', puntaje: -999, motivos: ['vacio'] };
  let puntaje = 50;
  const motivos = [];
  const len = texto.length;
  if (len >= 40 && len <= 70) { puntaje += 25; motivos.push('largo_ideal'); }
  else if (len >= 22 && len <= 88) { puntaje += 11; motivos.push('largo_ok'); }
  else { puntaje -= 15; motivos.push('fuera_rango'); }

  const prim = (texto.toLowerCase().split(/\s+/)[0] || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  if (MULETILLAS.has(prim)) { puntaje -= 22; motivos.push('muletilla'); }
  else { puntaje += 8; motivos.push('inicio_limpio'); }

  const setTr = new Set(claves(transcripcion));
  const cKeys = claves(texto);
  const hits = cKeys.filter((w) => setTr.has(w)).length;
  if (hits > 0) { puntaje += Math.min(20, hits * 5); motivos.push('trans_' + hits); }

  const unicas = new Set(cKeys);
  if (cKeys.length > unicas.size) { puntaje -= (cKeys.length - unicas.size) * 8; motivos.push('repetidas'); }

  const bKeys = claves(queBuscar);
  const mBus = bKeys.filter((k) => cKeys.includes(k)).length;
  if (mBus > 0) { puntaje += Math.min(25, mBus * 10); motivos.push('que_buscar'); }

  return { texto, puntaje, motivos };
}

export function generarCandidatosTitulo({ transcripcion = '', gancho = '', tituloFuente = '', queBuscar = '', respaldoActual = '' } = {}) {
  const frases = extraerFrasesFuertes(transcripcion);
  const gLimpio = cortarLimpio(gancho, 70);
  const f1 = cortarLimpio(frases[0] || '', 70);
  const fFuerte = cortarLimpio([...frases].sort((a, b) => claves(b).length - claves(a).length)[0] || '', 70);
  const fNum = cortarLimpio(frases.find((p) => /\d/.test(p)) || '', 70);
  const baseP = fFuerte || gLimpio || f1;
  const preg = baseP ? cortarLimpio(baseP.endsWith('?') ? baseP : '¿' + baseP.replace(/^¿+|^\?+|\?+$/g, '') + '?', 70) : '';
  const resp = cortarLimpio(respaldoActual || tituloFuente || 'Clip destacado', 70);

  const crudos = [
    { tipo: 'gancho', valor: gLimpio },
    { tipo: 'frase_1', valor: f1 },
    { tipo: 'fuerte', valor: fFuerte },
    { tipo: 'pregunta', valor: preg },
    { tipo: 'numero', valor: fNum },
    { tipo: 'respaldo', valor: resp }
  ];
  const vistos = new Set();
  const candidatos = [];
  for (const it of crudos) {
    const ev = puntuarTitulo(it.valor, { transcripcion, queBuscar });
    if (!ev.texto) continue;
    const k = ev.texto.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    candidatos.push({ titulo: ev.texto, tipo: it.tipo, puntaje: ev.puntaje, motivos: ev.motivos });
  }
  candidatos.sort((a, b) => b.puntaje - a.puntaje);
  return {
    titulo: candidatos[0]?.titulo || limpiarTextoBase(respaldoActual) || 'Clip destacado',
    alternativas: candidatos.map((c) => c.titulo),
    candidatos
  };
}
