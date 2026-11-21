// Respuesta estandar de la API: { success, data, error }.
// Los controladores siguen escribiendo { ok, ...campos } / { ok:false, error }; aqui se normaliza
// para que TODA respuesta JSON bajo /api tenga la misma forma, incluidos 401/404/500.
//
// Exito parcial (207, p. ej. publicar en 3 redes y que una falle): NO es un error total. Se responde
// { success:true, data:{ parcial:true, resultados:[...por red...], ... }, error:"TikTok: <motivo real>" }.
// Si TODO falla (>=400) con detalle por red, el detalle viaja igualmente en data.resultados y el error real en `error`.

function resumenFallos(resultados) {
  if (!Array.isArray(resultados)) return '';
  return resultados
    .filter((r) => r && r.ok === false)
    .map((r) => (r.etiqueta || r.red || 'red') + ': ' + String(r.error || 'fallo sin detalle'))
    .join(' | ');
}

export function envelope(req, res, next) {
  const original = res.json.bind(res);

  res.json = (cuerpo) => {
    if (cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) && 'success' in cuerpo) {
      return original(cuerpo);
    }

    const { ok, error, stderr, ...resto } = cuerpo && typeof cuerpo === 'object' ? cuerpo : { valor: cuerpo };

    if (res.statusCode === 207) {
      return original({
        success: true,
        data: { ...resto, parcial: true },
        error: error || resumenFallos(resto.resultados) || 'Exito parcial: revisa el detalle por red',
      });
    }

    const exito = res.statusCode < 400 && ok !== false;

    if (exito) {
      return original({ success: true, data: resto, error: null });
    }

    const detalle = resumenFallos(resto.resultados);
    const respuesta = {
      success: false,
      data: Array.isArray(resto.resultados) ? { clipId: resto.clipId ?? null, resultados: resto.resultados } : null,
      error: error || detalle || 'Error ' + res.statusCode,
    };
    if (stderr) respuesta.stderr = stderr;
    return original(respuesta);
  };

  next();
}
