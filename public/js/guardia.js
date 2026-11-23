// Guardia de arranque (script CLASICO, no modulo). Va ANTES de los modulos porque un `import` roto aborta el modulo
// antes de ejecutar una sola linea suya: si esta guardia viviera dentro de panel.js nunca podria avisar.
// Muestra en el indicador (#sync-texto) el error real en vez de dejar "Conectando..." para siempre.
(function () {
  function pintar(texto) {
    try {
      var sync = document.getElementById('sync');
      var txt = document.getElementById('sync-texto');
      if (sync) sync.dataset.estado = 'error';
      if (txt) txt.textContent = texto;
    } catch (e) { /* sin DOM todavia */ }
  }

  window.addEventListener('error', function (e) {
    var mensaje = (e && e.message) || 'revisa la consola del navegador';
    pintar('Error al cargar el panel: ' + String(mensaje).slice(0, 140));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var razon = e && e.reason;
    pintar('Error de red o promesa: ' + String((razon && razon.message) || razon || 'revisa la consola').slice(0, 140));
  });

  // Si el panel nunca llega a sondear (ni exito ni error), se avisa en lugar de quedarse mudo.
  setTimeout(function () {
    var txt = document.getElementById('sync-texto');
    if (txt && /conectando/i.test(txt.textContent || '')) {
      pintar('Sin respuesta del panel: recarga con Ctrl+F5 y revisa la consola.');
    }
  }, 10000);
})();
