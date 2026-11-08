// Bitácora de lotes (tabla lote_eventos). Fuera de una transacción es "mejor esfuerzo": si la base falla no
// interrumpe el trabajo. Dentro de una transacción (se pasa client.query) el error se propaga para que revierta.
import { q } from "./db.js";

const SQL = "INSERT INTO lote_eventos(lote_id, ciclo_id, item_id, variante_id, evento, estado, detalle) VALUES($1,$2,$3,$4,$5,$6,$7)";

export function evento({ lote, ciclo, item, variante, tipo, estado = null, detalle = null }, consulta) {
  const params = [lote ?? null, ciclo ?? null, item ?? null, variante ?? null, tipo, estado, detalle == null ? null : String(detalle).slice(0, 500)];
  const p = (consulta || q)(SQL, params);
  return consulta ? p : p.catch(e => console.error("lote_eventos:", e.message));
}
