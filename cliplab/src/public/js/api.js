// Cliente HTTP del panel. Todo cuelga de /api (ya detrás de requireAuth: la cookie viaja sola).

export class ErrorApi extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function llamar(metodo, ruta, cuerpo) {
  const opts = { method: metodo, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (cuerpo !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(cuerpo); }
  let res;
  try { res = await fetch("/api" + ruta, opts); }
  catch { throw new ErrorApi("Sin conexión con el servidor.", 0); }
  const tipo = res.headers.get("content-type") || "";
  if (res.status === 401 || (res.redirected && !tipo.includes("json"))) { location.href = "/"; throw new ErrorApi("Sesión expirada.", 401); }
  const data = tipo.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ErrorApi(data?.error || `Error ${res.status}`, res.status);
  return data;
}

export const api = {
  get: r => llamar("GET", r),
  post: (r, b = {}) => llamar("POST", r, b),
  put: (r, b) => llamar("PUT", r, b),
  del: r => llamar("DELETE", r)
};

// Catálogo de endpoints. Lo marcado "Fase 6" aún no existe en el backend: el panel lo trata como opcional.
export const EP = {
  estado: "/estado",
  clips: "/clips",
  fuentes: "/fuentes",
  monitor: "/lotes/monitor",
  ciclos: "/ciclos",
  lotes: "/lotes",
  // Fase 6 (reservado: transmisiones en vivo y captura en tiempo real)
  vivo: { estado: "/vivo/estado", eventos: "/vivo/eventos" }
};
