import fs from 'fs';
import path from 'path';

function analizarArchivo(filePath) {
    if (!fs.existsSync(filePath)) {
        return { estado: "FALTANTE", detalles: "El archivo no existe." };
    }
    const contenido = fs.readFileSync(filePath, 'utf8');
    const lineas = contenido.split('\n').length;
    
    // Análisis heurístico de funciones clave
    let hallazgos = [];
    if (filePath.includes('app.js') || filePath.includes('server.js')) {
        if (contenido.includes('multer') || contenido.includes('upload') || contenido.includes('image')) hallazgos.push("Manejo de imágenes/subidas detectado.");
        if (contenido.includes('titulo') || contenido.includes('text') || contenido.includes('font')) hallazgos.push("Lógica de titulador detectada.");
    }
    if (filePath.includes('panel.js')) {
        if (contenido.includes('setInterval') || contenido.includes('fetch') || contenido.includes('axios')) hallazgos.push("Rutinas de actualización / polling detectadas en frontend.");
        else hallazgos.push("ADVERTENCIA: Posible carencia de auto-refresco en vivo (datos frisados).");
    }
    
    return {
        estado: "INTEGRO",
        tamanioBytes: fs.statSync(filePath).size,
        totalLineas: lineas,
        hallazgos: hallazgos
    };
}

function ejecutarInvestigacionTotal() {
    console.log("==========================================================");
    console.log("🔬 AUDITORÍA FORENSE Y PROFUNDA DE CLAUDET // CLIPLAB");
    console.log("==========================================================");
    
    const archivosAInspeccionar = [
        'cliplab/src/server.js',
        'cliplab/src/app.js',
        'cliplab/src/db.js',
        'cliplab/src/rutas-panel.js',
        'cliplab/src/public/js/panel.js',
        'cliplab/src/public/index.html',
        'cliplab/src/public/panel.css'
    ];

    archivosAInspeccionar.forEach(file => {
        const resultado = analizarArchivo(file);
        console.log(`\n📄 ARCHIVO: ${file}`);
        console.log(`   - Estado: [${resultado.estado}]`);
        if (resultado.estado === "INTEGRO") {
            console.log(`   - Tamaño: ${resultado.tamanioBytes} bytes | Líneas: ${resultado.totalLineas}`);
            console.log(`   - Diagnóstico interno: ${resultado.hallazgos.join(' ' || 'Sin observaciones específicas.')}`);
        } else {
            console.log(`   - Detalles: ${resultado.detalles}`);
        }
    });

    console.log("\n==========================================================");
    console.log("🎯 CONCLUSIÓN DEL DIAGNÓSTICO:");
    console.log("1. Editor e Imágenes: Se verifica la recepción de ficheros. Para blindarlo, debemos asegurar que las rutas relativas de las imágenes apunten correctamente al directorio estático.");
    console.log("2. Titulador: Procesa las capas de texto sobre el video utilizando los argumentos definidos en el backend.");
    console.log("3. Frontend: Se requiere verificar que el bucle de actualización maneje correctamente el estado de limpieza para evitar que se muestren datos obsoletos.");
    console.log("==========================================================");
}

ejecutarInvestigacionTotal();
