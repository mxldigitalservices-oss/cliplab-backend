// ---------------------------------------------------------------------------
// Diccionario de palabras clave del curador (curador.js). Datos puros: sin red, sin IA externa.
//   - Cada categoria tiene terminos "fuerte" (peso 2) y "medio" (peso 1).
//   - Un termino que termina en * es una raiz (aprend* -> aprender, aprendi, aprendizaje).
//   - Todo se compara normalizado (minusculas, sin acentos, sin signos): "¿Sabías?" == "sabias".
// Para ampliar el diccionario basta con agregar terminos a estas listas.
// ---------------------------------------------------------------------------

export function normalizar(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export const DICCIONARIO = Object.freeze({
  // Palabras que enganchan en los primeros segundos (curiosidad, tension, promesa).
  gancho: {
    fuerte: [
      'secreto', 'secretos', 'error*', 'nunca', 'jamas', 'nadie', 'verdad', 'mentira*', 'ojo', 'cuidado', 'atencion',
      'peligro*', 'imagina*', 'increible', 'locura', 'escandalo', 'prohibido', 'gratis', 'millon*', 'millones', 'truco*',
      'clave', 'razon', 'urgente', 'advertencia', 'confesion', 'descubri*', 'revelo', 'sorprend*',
      'secret', 'secrets', 'mistake*', 'never', 'nobody', 'truth', 'lie', 'lies', 'warning', 'free', 'million*', 'trick*', 'shocking',
    ],
    medio: [
      'porque', 'siempre', 'todos', 'ganar', 'perder', 'dinero', 'rapido', 'facil', 'imposible', 'problema*', 'miedo',
      'cambio*', 'historia', 'resultado*', 'antes', 'despues', 'mejor', 'peor', 'unico', 'primero',
      'why', 'how', 'always', 'money', 'easy', 'fast', 'problem*', 'fear', 'story', 'best', 'worst',
    ],
    frases: [
      'lo que nadie', 'la verdad es', 'sabias que', 'sabes que', 'te voy a', 'no te vas', 'el error mas', 'el secreto',
      'la razon por', 'por que', 'como hacer', 'esto es lo que', 'el problema es', 'nadie te', 'lo mas importante',
      'you need to', 'here is why', 'the truth', 'the secret', 'nobody tells', 'what nobody',
    ],
  },
  // Contenido que aporta (consejos, metodos, datos, ejemplos).
  valor: {
    fuerte: [
      'consejo*', 'paso', 'pasos', 'metodo*', 'estrategia*', 'formula*', 'sistema*', 'regla*', 'ejemplo*', 'aprend*',
      'solucion*', 'resultado*', 'herramienta*', 'proceso*', 'guia', 'tecnica*', 'framework', 'leccion*',
      'tip', 'tips', 'step', 'steps', 'method*', 'strategy', 'lesson*', 'learn*', 'example*', 'result*', 'solution*', 'tool*',
    ],
    medio: [
      'importante', 'clave', 'necesitas', 'debes', 'evita*', 'recuerda*', 'enfoca*', 'objetivo*', 'plan', 'habito*',
      'rutina', 'ahorr*', 'invers*', 'ventas', 'clientes', 'negocio*', 'marketing', 'productividad', 'tiempo', 'dato*',
      'estudio*', 'porcentaje', 'ingreso*', 'ganancia*', 'empresa*', 'emprend*',
      'important', 'need', 'avoid', 'remember', 'goal*', 'habit*', 'sales', 'customers', 'business', 'data', 'income', 'profit*',
    ],
  },
  // Emocion, curiosidad, historia, polemica.
  interes: {
    fuerte: [
      'increible', 'impresionante', 'brutal', 'locura', 'loco', 'alucinante', 'impactante', 'polemic*', 'escandalo',
      'sorprend*', 'viral', 'miedo', 'panico', 'dolor', 'llorar', 'risa', 'historia', 'anecdota', 'confesion', 'traicion',
      'exito', 'fracaso', 'quiebra', 'lujo', 'secreto',
      'amazing', 'incredible', 'crazy', 'insane', 'shocking', 'viral', 'fear', 'story', 'failure', 'success',
    ],
    medio: [
      'nunca', 'jamas', 'siempre', 'sorpresa', 'curioso', 'raro', 'extrano', 'diferente', 'unico', 'mejor', 'peor',
      'primera', 'ultima', 'gigante', 'enorme', 'repente', 'pero', 'aunque',
      'never', 'always', 'weird', 'strange', 'different', 'biggest', 'worst',
    ],
  },
  // Conectores que delatan que la frase NO se entiende sin la anterior (mal inicio de clip).
  dependientes: ['y', 'pero', 'porque', 'entonces', 'pues', 'aunque', 'sino', 'ademas', 'tambien', 'eso', 'and', 'but', 'so', 'because', 'also', 'then'],
  dependientesBi: ['o sea', 'por eso', 'asi que', 'es decir', 'sin embargo', 'por lo tanto', 'and then', 'so then'],
  // Muletillas: una frase que arranca con ellas es un inicio flojo.
  rellenos: ['eh', 'ehh', 'mmm', 'um', 'uh', 'este', 'bueno', 'osea', 'tipo', 'like', 'okay', 'ok'],
  contraste: ['pero', 'aunque', 'sino', 'but', 'however', 'although'],
});

function compilar({ fuerte, medio }) {
  const exactos = new Map();
  const raices = new Map();
  const poner = (lista, peso) => {
    for (const termino of lista) {
      const esRaiz = termino.endsWith('*');
      const clave = normalizar(termino.replace('*', ''));
      if (!clave) continue;
      const mapa = esRaiz ? raices : exactos;
      mapa.set(clave, Math.max(mapa.get(clave) || 0, peso));
    }
  };
  poner(medio, 1);
  poner(fuerte, 2);
  return { exactos, raices };
}

export const INDICE = Object.freeze({
  gancho: compilar(DICCIONARIO.gancho),
  valor: compilar(DICCIONARIO.valor),
  interes: compilar(DICCIONARIO.interes),
});

/** Peso (0, 1 o 2) de un token ya normalizado dentro de un indice compilado. */
export function pesoDe(indice, token) {
  const exacto = indice.exactos.get(token);
  if (exacto) return exacto;
  if (indice.raices.size === 0) return 0;
  for (let k = Math.min(token.length, 10); k >= 4; k--) {
    const raiz = indice.raices.get(token.slice(0, k));
    if (raiz) return raiz;
  }
  return 0;
}

const unir = (lista) => new Set(lista.map(normalizar).filter(Boolean));
const unirFrases = (lista) => lista.map((f) => f.split(/\s+/).map(normalizar).filter(Boolean).join(' '));

export const FRASES_GANCHO = unirFrases(DICCIONARIO.gancho.frases);
export const DEPENDIENTES = unir(DICCIONARIO.dependientes);
export const DEPENDIENTES_BI = new Set(unirFrases(DICCIONARIO.dependientesBi));
export const RELLENOS = unir(DICCIONARIO.rellenos);
export const CONTRASTE = unir(DICCIONARIO.contraste);

export const STOP = unir((
  'de la que el en y a los se del las un por con no una su para es al lo como mas pero sus le ya o este si porque esta ' +
  'entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese ' +
  'eso ante ellos esto antes algunos unos yo otro otras otra tanto esa estos mucho nada muchos cual poco ella estar ' +
  'estas algo nosotros mis te ti tu tus ser son fue era pues bueno entonces tipo asi aqui alli vez cosa cosas puede ' +
  'pueden hacer hace tiene tienen the and that this with for are was you your have not but from they will what about ' +
  'there their when which would just like then than very really yeah okay'
).split(/\s+/));
