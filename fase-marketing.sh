#!/usr/bin/env bash
# ClipLab Pro - Fase Marketing y Distribución
# Ejecutar desde la raíz del proyecto. Crea módulos nuevos; no sobrescribe los existentes.
set -euo pipefail
mkdir -p src db/migrations public/js public/css

# ───────────────────────── 1. MIGRACIÓN SQL ─────────────────────────
cat << 'EOF_SQL' > db/migrations/002_marketing.sql
ALTER TABLE vivo_clips
  ADD COLUMN IF NOT EXISTS copy_marketing      JSONB,
  ADD COLUMN IF NOT EXISTS copy_variante       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS distribucion_estado TEXT,
  ADD COLUMN IF NOT EXISTS distribucion_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS distribucion_error  TEXT;
EOF_SQL

# ───────────────────────── 2. MOTOR DE COPY (100% local) ─────────────────────────
cat << 'EOF_MK' > src/marketing.js
'use strict';
const crypto = require('crypto');

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const semilla = (txt) => parseInt(crypto.createHash('md5').update(txt).digest('hex').slice(0, 8), 16);
const pick = (arr, h, off = 0) => arr[(h + off) % arr.length];

const STOP = new Set(norm(
  'de la que el en y a los se del las un por con no una su para es al lo como mas pero sus le ya o este si porque esta ' +
  'entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese ' +
  'eso ante ellos esto antes algunos unos yo otro otras otra tanto esa estos mucho nada muchos cual poco ella estar ' +
  'estas algo nosotros mis te ti tu tus ser son fue era pues bueno entonces tipo asi aqui alli vez cosa cosas puede ' +
  'pueden hacer hace tiene tienen the and that this with for are was you your have not but from they will what about ' +
  'there their when which would just like then than very really yeah okay'
).split(/\s+/));

const NICHOS = {
  negocios: {
    emojis: ['💰', '📈', '🚀'], etiqueta: 'negocios',
    tags: ['negocios', 'emprendimiento', 'finanzas'],
    claves: ['negocio', 'empresa', 'venta', 'dinero', 'ingreso', 'cliente', 'startup', 'emprend', 'marketing', 'inversion', 'business', 'money', 'revenue', 'sales', 'profit'],
    ganchos: [
      (t) => `Lo que nadie te cuenta sobre ${t}`,
      (t) => `El error con ${t} que te cuesta dinero`,
      (t) => `Así se gana dinero con ${t}`,
      (t) => `${t}: la lección que lo cambió todo`,
    ],
  },
  tecnologia: {
    emojis: ['🤖', '💻', '⚡'], etiqueta: 'tecnología',
    tags: ['tecnologia', 'ia', 'innovacion'],
    claves: ['tecnolog', 'software', 'codigo', 'program', 'inteligencia', 'artificial', 'datos', 'robot', 'digital', 'tech', 'modelo', 'algorit', 'chip', 'ia '],
    ganchos: [
      (t) => `${t} está cambiando las reglas del juego`,
      (t) => `Lo que viene con ${t} te va a sorprender`,
      (t) => `Pocos entienden esto sobre ${t}`,
      (t) => `${t}: lo que las big tech no dicen`,
    ],
  },
  debate: {
    emojis: ['🔥', '🗣️', '⚖️'], etiqueta: 'debate',
    tags: ['debate', 'opinion', 'actualidad'],
    claves: ['debate', 'opinion', 'politica', 'sociedad', 'argument', 'polemic', 'discusion', 'verdad', 'mentira', 'cultura', 'gobierno', 'ley'],
    ganchos: [
      (t) => `¿Tienen razón con ${t}? Esto abrió el debate`,
      (t) => `La opinión más polémica sobre ${t}`,
      (t) => `Nadie quiere hablar de ${t}, pero aquí está`,
      (t) => `${t}: ¿estás de acuerdo?`,
    ],
  },
  entretenimiento: {
    emojis: ['🎬', '😂', '🔥'], etiqueta: 'entretenimiento',
    tags: ['entretenimiento', 'viral', 'podcast'],
    claves: ['pelicula', 'serie', 'musica', 'famos', 'chiste', 'historia', 'podcast', 'show', 'juego', 'humor', 'celebr', 'anecdota'],
    ganchos: [
      (t) => `No vas a creer lo que pasó con ${t}`,
      (t) => `El momento más épico sobre ${t}`,
      (t) => `Esto sobre ${t} se hizo viral por algo`,
      (t) => `La historia de ${t} que nadie esperaba`,
    ],
  },
  general: {
    emojis: ['✨', '👀', '🎯'], etiqueta: 'contenido como este',
    tags: ['viral', 'aprende', 'contenido'],
    claves: [],
    ganchos: [
      (t) => `Lo que tienes que saber sobre ${t}`,
      (t) => `Mira esto antes de opinar sobre ${t}`,
      (t) => `${t}: lo que casi nadie te explica`,
      (t) => `Esto cambia cómo ves ${t}`,
    ],
  },
};

const CTAS = [
  (n) => `👇 Sígueme para más contenido de ${n}`,
  () => '💬 ¿Qué opinas? Te leo en los comentarios',
  () => '🔔 Guárdalo y compártelo con quien lo necesite',
  () => '➡️ Sígueme para la parte 2',
];

function recortar(s, max) {
  s = String(s || '').trim();
  if (s.length <= max) return s;
  const c = s.slice(0, max - 1);
  const i = c.lastIndexOf(' ');
  return (i > max * 0.6 ? c.slice(0, i) : c).replace(/[\s,.;:]+$/, '') + '…';
}

function primeraFrase(texto, max) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.+?[.!?](\s|$)/);
  return recortar(m ? m[0] : t, max);
}

function detectarNicho(texto) {
  const t = norm(texto);
  let mejor = 'general';
  let max = 0;
  for (const [nombre, cfg] of Object.entries(NICHOS)) {
    const score = cfg.claves.filter((k) => t.includes(k)).length;
    if (score > max) { max = score; mejor = nombre; }
  }
  return mejor;
}

function palabrasClave(texto, previas, n) {
  const out = [];
  const vistos = new Set();
  const add = (texto0, minLen) => {
    const display = String(texto0).trim().toLowerCase();
    const tag = norm(display).replace(/[^a-z0-9]/g, '');
    if (tag.length >= minLen && !vistos.has(tag)) { vistos.add(tag); out.push({ tag, texto: display }); }
  };
  (Array.isArray(previas) ? previas : []).forEach((p) => add(p, 3));
  const frec = new Map();
  (String(texto || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).forEach((w) => {
    const k = norm(w);
    if (w.length >= 5 && !STOP.has(k) && !/^\d+$/.test(k)) {
      const e = frec.get(k) || { w, c: 0 };
      e.c += 1;
      frec.set(k, e);
    }
  });
  [...frec.values()].sort((a, b) => b.c - a.c).forEach((e) => add(e.w, 5));
  return out.slice(0, n);
}

function generarCopy(clip, variante = 0) {
  const titulo = String(clip.titulo || '').trim();
  const previas = Array.isArray(clip.palabras_clave) ? clip.palabras_clave : [];
  const base = [titulo, clip.resumen, clip.transcripcion, clip.origen_titulo].filter(Boolean).join(' ');
  const nicho = detectarNicho(`${base} ${previas.join(' ')}`);
  const cfg = NICHOS[nicho];
  const kws = palabrasClave(base, previas, 8);
  const h = semilla(`${clip.id || ''}|${titulo}|${variante}`);

  const tema = (kws[0] && kws[0].texto) || recortar(titulo, 40) || 'este tema';
  const g0 = recortar(pick(cfg.ganchos, h)(tema), 90);
  const gancho = g0.charAt(0).toUpperCase() + g0.slice(1);

  const resumen = primeraFrase(clip.resumen || titulo, 160);
  const descripcion = `${pick(cfg.emojis, h)} ${resumen}\n${pick(cfg.emojis, h, 1)} Mira hasta el final.`;
  const cta = pick(CTAS, h, 1)(cfg.etiqueta);

  const tags = [...new Set([...cfg.tags, ...kws.map((k) => k.tag)])].slice(0, 8);
  const tagsDe = (n, extra = []) => [...new Set([...tags.slice(0, n), ...extra])].map((t) => `#${t}`).join(' ');

  return {
    version: 1,
    nicho,
    gancho,
    descripcion,
    cta,
    hashtags: tags.map((t) => `#${t}`),
    plataformas: {
      tiktok: { texto: recortar([gancho, descripcion, cta, tagsDe(4, ['fyp', 'parati'])].join('\n\n'), 2200) },
      reels: { texto: recortar([gancho, descripcion, cta, tagsDe(5, ['reels'])].join('\n\n'), 2200) },
      shorts: {
        titulo: `${recortar(gancho, 90)} #Shorts`,
        descripcion: recortar([descripcion, cta, tagsDe(3, ['shorts'])].join('\n\n'), 5000),
      },
    },
    generado_en: new Date().toISOString(),
  };
}

module.exports = { generarCopy, detectarNicho, palabrasClave };
EOF_MK

echo "Script fase-marketing.sh creado y listo en la raíz."
