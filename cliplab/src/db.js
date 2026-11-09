import pkg from 'pg';
const { Pool } = pkg;

export async function iniciarDb() {
    console.log("[DB] Modo local simulado activo: omitiendo conexión estricta de Postgres.");
    return {
        query: async () => ({ rows: [] })
    };
}

export const pool = {
    query: async () => ({ rows: [] })
};
