const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cfg = require('./config');

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.pgSsl ? { rejectUnauthorized: false } : undefined,
  max: cfg.pgPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[db] error en cliente inactivo:', err.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  let client;
  for (let i = 1; i <= 10; i++) {
    try {
      client = await pool.connect();
      break;
    } catch (err) {
      console.error(`[db] conexión fallida (${i}/10): ${err.message}`);
      if (i === 10) throw err;
      await sleep(3000);
    }
  }
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(sql);
    console.log('[db] esquema verificado');
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727274)'); } catch (_) {}
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  migrate,
  close: () => pool.end(),
};
