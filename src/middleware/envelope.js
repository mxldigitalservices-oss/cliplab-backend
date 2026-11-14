// Respuesta estandar de la API: { success, data, error }.
// Los controladores siguen escribiendo { ok, ...campos } / { ok:false, error }; aqui se normaliza
// para que TODA respuesta JSON bajo /api tenga la misma forma, incluidos 401/404/500.
export function envelope(req, res, next) {
  const original = res.json.bind(res);

  res.json = (cuerpo) => {
    if (cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) && 'success' in cuerpo) {
      return original(cuerpo);
    }

    const { ok, error, stderr, ...resto } = cuerpo && typeof cuerpo === 'object' ? cuerpo : { valor: cuerpo };
    const exito = res.statusCode < 400 && ok !== false;

    if (exito) {
      return original({ success: true, data: resto, error: null });
    }

    const respuesta = { success: false, data: null, error: error || 'Error ' + res.statusCode };
    if (stderr) respuesta.stderr = stderr;
    return original(respuesta);
  };

  next();
}
