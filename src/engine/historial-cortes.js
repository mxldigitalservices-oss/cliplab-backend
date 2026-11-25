import crypto from "node:crypto";

export function claveVideo(fuente = "") {
  return crypto
    .createHash("sha256")
    .update(String(fuente || "").trim())
    .digest("hex")
    .slice(0, 16);
}

export function haySolapamiento(aInicio, aFin, bInicio, bFin, toleranciaSeg = 5) {
  const inicioMayor = Math.max(Number(aInicio || 0), Number(bInicio || 0));
  const finMenor = Math.min(Number(aFin || 0), Number(bFin || 0));
  return finMenor - inicioMayor > toleranciaSeg;
}

export function filtrarCortesNoRepetidos(
  candidatos = [],
  rangosUsados = [],
  toleranciaSeg = 5
) {
  return (Array.isArray(candidatos) ? candidatos : []).filter((c) => {
    const inicio = Number(c.inicio ?? c.start ?? 0);
    const fin = Number(c.fin ?? c.end ?? inicio);
    return !rangosUsados.some((usado) =>
      haySolapamiento(inicio, fin, usado.inicio, usado.fin, toleranciaSeg)
    );
  });
}
