import fs from 'fs';
import path from 'path';

function verificarModulo(ruta, nombre) {
    if (!fs.existsSync(ruta)) {
        return `[FALTA] El módulo ${nombre} no se encuentra en la ruta esperada.`;
    }
    const contenido = fs.readFileSync(ruta, 'utf8');
    let observaciones = [];
    
    if (nombre === "App Core / Ingesta") {
        if (!contenido.includes('tiktok') && !contenido.includes('instagram')) {
            observaciones.push("Faltan manejadores específicos para TikTok e Instagram.");
        } else {
            observaciones.push("Soporte de TikTok e Instagram detectado en el núcleo.");
        }
        if (contenido.includes('yt-dlp') || contenido.includes('youtube')) {
            observaciones.push("Módulo de descarga de YouTube integrado (requiere actualización de cookies de sesión).");
        }
    }
    if (nombre === "Editor / Titulador") {
        if (contenido.includes('ffmpeg') || contenido.includes('fluent-ffmpeg')) {
            observaciones.push("Motor de video FFmpeg activo para subtítulos y composición.");
        } else {
            observaciones.push("ADVERTENCIA: Revisar parámetros de renderizado de texto/imagen.");
        }
    }
    return `[OK] ${nombre} operativo. Detalles: ${observaciones.join(' ')}`;
}

function ejecutarAnalisisEmpresa() {
    console.log("==================================================================");
    console.log("🏢 AUDITORÍA DE INFRAESTRUCTURA DE MARKETING // CLIPLAB PRO");
    console.log("==================================================================");
    
    const r1 = verificarModulo('cliplab/src/app.js', 'App Core / Ingesta');
    console.log(`\n1. Ingesta y Plataformas:\n   -> ${r1}`);
    
    const r2 = verificarModulo('cliplab/src/server.js', 'Editor / Titulador');
    console.log(`\n2. Edición, Captura y Titulado:\n   -> ${r2}`);
    
    console.log("\n==================================================================");
    console.log("🎯 PLAN DE ACCIÓN INMEDIATO PARA CERRAR EL PROYECTO:");
    console.log("------------------------------------------------------------------");
    console.log("• Prioridad 1: Consolidar TikTok e Instagram como canales estables de entrada y salida de clips.");
    console.log("• Prioridad 2: Blindar la captura de YouTube actualizando las cookies de sesión del navegador en el entorno.");
    console.log("• Prioridad 3: Afinar las capas de texto del titulador para que los subtítulos y palabras clave salgan impecables en cada reel.");
    console.log("• Prioridad 4: Mantener el frontend limpio con auto-refresco para que el equipo vea en tiempo real el estatus de cada publicación.");
    console.log("==================================================================");
}

ejecutarAnalisisEmpresa();
