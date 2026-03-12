
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
    const url = process.env.DB_NEXUS_CREATIVE_URL;
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try {
        const res = await pool.query(`SELECT * FROM analytics_events LIMIT 1`);
        console.log("Nexus Analytics Events Columns:");
        console.log(Object.keys(res.rows[0] || {}));
    } catch (e) {
        console.error(e.message);
    } finally {
        await pool.end();
    }
}

check();
