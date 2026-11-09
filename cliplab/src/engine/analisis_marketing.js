function generarCopysYLlamados(titulo, resumen) {
  const t = titulo || 'Contenido imperdible';
  return {
    tiktok: `🔥 ¡Mira esto! ${t}. Comenta qué opinas abajo. 👇 #Viral #ClipLabPro`,
    instagram: `💡 Reflexión clave: ${t}. \n\n${resumen || ''}\n\n¿Estás de acuerdo? Guárdalo y compártelo. 🚀 #Reels #Tendencia`,
    facebook: `📌 Análisis completo: ${t}\n\nDetalles destacados: ${resumen || 'Mira el video completo y descubre más.'}\n\n💬 Déjanos tu comentario.`,
    youtube: `✨ ${t} | Extracto clave generado automáticamente por ClipLab Pro.`
  };
}
module.exports = { generarCopysYLlamados };
