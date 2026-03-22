const { Pool } = require('pg');
require('dotenv').config();

async function checkCols(envKey, table) {
    const url = process.env[envKey];
    if (!url) return console.log(envKey, 'Missing');
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }});
    try {
        const res = await pool.query(`SELECT * FROM ${table} LIMIT 1`);
        const row = res.rows[0];
        console.log(envKey, table, 'COLUMNS:', row ? Object.keys(row) : 'EMPTY');
    } catch(e) { console.log(envKey, table, 'error:', e.message); }
    await pool.end();
}

(async () => {
   await checkCols('DB_FARKLE_STAGING_URL', 'users');
   await checkCols('DB_SPELLING_BEE_URL', 'visitor_logs');
   await checkCols('DB_NEXUS_CREATIVE_URL', 'analytics_events');
   await checkCols('DB_LINK_VEROE_SPACE_URL', 'pixel_hits');
})();
