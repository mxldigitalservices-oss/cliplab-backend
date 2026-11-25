export const CONFIG_RETENCION_CLIP = {
  duracionMinimaSeg: Number(process.env.CLIP_MIN_SEG || 45),
  duracionObjetivoSeg: Number(process.env.CLIP_TARGET_SEG || 65),
  duracionMaximaSeg: Number(process.env.CLIP_MAX_SEG || 90),
  extensionCierreMaxSeg: Number(process.env.CLIP_CLOSE_PAD_SEG || 8),
  exigirCierreOracion: true,
};

export function ajustarVentanaNarrativa(candidato, duracionTotalVideo) {
  const minSeg = CONFIG_RETENCION_CLIP.duracionMinimaSeg;
  const maxSeg = CONFIG_RETENCION_CLIP.duracionMaximaSeg;
  const padCierre = CONFIG_RETENCION_CLIP.extensionCierreMaxSeg;

  let inicio = Math.max(0, Number(candidato.inicio || 0));
  let fin = Math.min(duracionTotalVideo, Number(candidato.fin || inicio + minSeg));

  if (fin - inicio < minSeg) {
    fin = Math.min(duracionTotalVideo, inicio + minSeg);
    if (fin - inicio < minSeg && inicio > 0) {
      inicio = Math.max(0, fin - minSeg);
    }
  }

  if (
    CONFIG_RETENCION_CLIP.exigirCierreOracion &&
    typeof candidato.siguientePausaCierreSeg === "number"
  ) {
    const finPropuesto = Math.min(
      duracionTotalVideo,
      Math.max(fin, candidato.siguientePausaCierreSeg)
    );
    if (finPropuesto - inicio <= maxSeg + padCierre) {
      fin = finPropuesto;
    }
  }

  if (fin - inicio > maxSeg) {
    fin = Math.min(duracionTotalVideo, inicio + maxSeg);
  }

  return {
    ...candidato,
    inicio: Number(inicio.toFixed(2)),
    fin: Number(fin.toFixed(2)),
    duracion: Number((fin - inicio).toFixed(2)),
  };
}
