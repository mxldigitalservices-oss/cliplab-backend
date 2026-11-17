// ---------------------------------------------------------------------------
// Interlocutor activo: a quien debe seguir la camara cuando hay dos personas en cuadro.
//
// Problema que resuelve: anclar la camara al rostro MAS GRANDE deja fuera de cuadro a la otra persona
// en cuanto ella interviene o gesticula, sobre todo si Haar la pierde por cuadros (postura, luz).
//
//   1. personasDe: agrupa las detecciones por posicion horizontal en "personas" persistentes. Una persona
//      que aparece solo en parte de los cuadros (>= PRESENCIA_MIN) sigue contando: no depende de que Haar
//      vea a las dos en cada cuadro.
//   2. actividad: movimiento medido por sujeto.py en la zona de cada persona (rostro + torso/manos),
//      suavizado en una ventana centrada. Es un indicador relativo de quien se mueve o gesticula; NO sabe
//      quien habla (eso pide audio).
//   3. elegirActivo: histéresis de cambio. Solo cambia de interlocutor si el otro supera al actual por
//      VENTAJA durante PERSISTENCIA muestras seguidas, y no vuelve a cambiar antes de DWELL muestras.
//   4. objetivosInterlocutor: si las dos personas caben en el crop 9:16, objetivo = centro del par;
//      si no caben, objetivo = el interlocutor activo, con un sesgo corto hacia el otro (centro ponderado).
//
// Variables de entorno: PERSONA_GAP, PERSONA_PRESENCIA, ACTIVO_VENTAJA, ACTIVO_PERSISTENCIA, ACTIVO_DWELL
// ---------------------------------------------------------------------------

const num = (v, def) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);

export const INT = {
  gap: num(process.env.PERSONA_GAP, 0.09), // separacion horizontal que distingue a dos personas
  presenciaMin: num(process.env.PERSONA_PRESENCIA, 0.35), // fraccion de cuadros con rostro en que debe aparecer
  minMuestras: 2,
  ventana: 2, // muestras a cada lado para suavizar la actividad
  ventaja: num(process.env.ACTIVO_VENTAJA, 1.4), // el otro debe superar al actual por este factor...
  epsilon: 0.002, // ...y por al menos esta actividad absoluta (ruido de compresion)
  persistencia: num(process.env.ACTIVO_PERSISTENCIA, 3), // ...durante estas muestras seguidas (0.75 s a 4 fps)
  dwell: num(process.env.ACTIVO_DWELL, 4), // muestras minimas entre dos cambios (1 s a 4 fps)
  sesgo: 0.2, // peso del otro interlocutor cuando no caben los dos en el crop
  sesgoMax: 0.06, // tope del sesgo (fraccion del frame): el activo nunca sale del crop
};

const mediana = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
const acotar = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Agrupa las detecciones de rostros de un corte en personas persistentes, de izquierda a derecha.
 * @returns [{ x, w, l, r, presencia, n }] (solo las que superan la presencia minima) o null si no hay datos
 */
export function personasDe(muestras, opt = {}) {
  const I = { ...INT, ...opt };
  const con = muestras.filter((s) => s.n > 0 && Array.isArray(s.rostros) && s.rostros.length > 0);
  if (con.length < I.minMuestras) return null;

  const pts = [];
  con.forEach((s, i) => s.rostros.forEach((f) => pts.push({ i, x: f.x, w: f.w })));
  pts.sort((a, b) => a.x - b.x);

  const grupos = [];
  for (const p of pts) {
    const g = grupos[grupos.length - 1];
    const media = g ? g.suma / g.pts.length : 0;
    if (g && p.x - media <= I.gap) { g.pts.push(p); g.suma += p.x; } else grupos.push({ pts: [p], suma: p.x });
  }
  const personas = grupos
    .map((g) => {
      const distintas = new Set(g.pts.map((p) => p.i)).size;
      return {
        x: mediana(g.pts.map((p) => p.x)),
        w: mediana(g.pts.map((p) => p.w)),
        l: mediana(g.pts.map((p) => p.x - p.w / 2)),
        r: mediana(g.pts.map((p) => p.x + p.w / 2)),
        presencia: distintas / con.length,
        n: distintas,
      };
    })
    .filter((p) => p.presencia >= I.presenciaMin && p.n >= I.minMuestras);
  return personas.length ? personas : null;
}

/** Asigna cada rostro de una muestra a la persona mas cercana (dentro del gap). Devuelve [rostro|null por persona]. */
function asignar(s, personas, gap) {
  const salida = personas.map(() => null);
  if (!Array.isArray(s.rostros)) return salida;
  for (const f of s.rostros) {
    let mejor = -1;
    let dist = gap;
    personas.forEach((p, k) => {
      const d = Math.abs(f.x - p.x);
      if (d <= dist) { dist = d; mejor = k; }
    });
    if (mejor >= 0 && (!salida[mejor] || f.w > salida[mejor].w)) salida[mejor] = f;
  }
  return salida;
}

/**
 * Posicion y actividad de cada persona en cada muestra.
 * @returns { pos: number[][], act: (number|null)[][] } indexados [persona][muestra]; pos mantiene la ultima posicion conocida.
 */
export function seguirPersonas(muestras, personas, opt = {}) {
  const I = { ...INT, ...opt };
  const asign = muestras.map((s) => asignar(s, personas, I.gap));
  const pos = personas.map((p, k) => {
    let ultimo = null;
    const serie = asign.map((a) => (a[k] ? a[k].x : null));
    // relleno hacia adelante y, para el comienzo, hacia atras; si nunca se vio, la posicion mediana
    const primero = serie.find((v) => v != null);
    ultimo = primero ?? p.x;
    return serie.map((v) => { if (v != null) ultimo = v; return ultimo; });
  });
  const crudo = personas.map((_, k) => asign.map((a) => (a[k] && Number.isFinite(a[k].act) ? a[k].act : null)));
  const act = crudo.map((serie) => serie.map((_, i) => {
    const v = serie.slice(Math.max(0, i - I.ventana), Math.min(serie.length, i + I.ventana + 1)).filter((x) => x != null);
    return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null;
  }));
  return { pos, act };
}

/**
 * Elige el interlocutor activo por muestra con histéresis de cambio.
 * @param act [persona][muestra] actividad suavizada (null = sin dato; cuenta como 0)
 * @param presencia presencia de cada persona (decide quien arranca cuando aun no hay actividad)
 * @returns { activos: number[], cambios: number }
 */
export function elegirActivo(act, presencia = [], opt = {}) {
  const I = { ...INT, ...opt };
  const n = act[0].length;
  const val = (k, i) => act[k][i] ?? 0;
  const supera = (k, i, actual) => val(k, i) > val(actual, i) * I.ventaja + I.epsilon;

  // arranca en quien tiene mas actividad en las primeras muestras; empate -> mayor presencia
  const ini = Math.min(n, 1 + I.persistencia);
  let sumas = [0, 0];
  for (let i = 0; i < ini; i++) { sumas = [sumas[0] + val(0, i), sumas[1] + val(1, i)]; }
  let actual = sumas[1] > sumas[0] * I.ventaja + I.epsilon ? 1 : sumas[0] > sumas[1] * I.ventaja + I.epsilon ? 0 : ((presencia[1] ?? 0) > (presencia[0] ?? 0) ? 1 : 0);

  const activos = [];
  let cambios = 0;
  let desdeCambio = I.dwell; // permite un primer cambio sin espera
  for (let i = 0; i < n; i++) {
    const otro = 1 - actual;
    let cambia = desdeCambio >= I.dwell && i + I.persistencia <= n;
    for (let j = 0; cambia && j < I.persistencia; j++) if (!supera(otro, i + j, actual)) cambia = false;
    if (cambia) { actual = otro; cambios++; desdeCambio = 0; } else desdeCambio++;
    activos.push(actual);
  }
  return { activos, cambios };
}

/**
 * Objetivo horizontal por muestra para un corte con DOS personas persistentes.
 * @returns { objetivos: number[], cambios: number, caben: boolean } alineado con `muestras`
 */
export function objetivosInterlocutor(muestras, personas, grupoMax, opt = {}) {
  const I = { ...INT, ...opt };
  const { pos, act } = seguirPersonas(muestras, personas, I);
  const mitad = personas.map((p) => p.w / 2);
  const caben = Math.max(personas[0].x + mitad[0], personas[1].x + mitad[1]) - Math.min(personas[0].x - mitad[0], personas[1].x - mitad[1]) <= grupoMax;
  const { activos, cambios } = elegirActivo(act, personas.map((p) => p.presencia), I);

  const objetivos = muestras.map((_, i) => {
    if (caben) {
      const l = Math.min(pos[0][i] - mitad[0], pos[1][i] - mitad[1]);
      const r = Math.max(pos[0][i] + mitad[0], pos[1][i] + mitad[1]);
      return (l + r) / 2;
    }
    const a = activos[i];
    const otro = pos[1 - a][i] - pos[a][i];
    const sesgo = acotar(otro * I.sesgo, -I.sesgoMax, I.sesgoMax);
    return acotar(pos[a][i] + sesgo, 0, 1);
  });
  return { objetivos, cambios, caben };
}
