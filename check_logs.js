const { Pool } = require('pg');
require('dotenv').config();

const url = process.env.DB_DOMAIN_HUB_URL;
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function check() {
    try {
        console.log("Connecting to", url.split('@')[1]); // Log host safely
        const res = await pool.query(`SELECT DISTINCT site_label FROM visitor_logs`);
        console.log("Existing site labels in Domain Hub:");
        console.log(res.rows);
        
        const logsRes = await pool.query(`SELECT * FROM visitor_logs ORDER BY timestamp DESC LIMIT 3`);
        console.log("\nSome latest rows:");
        console.log(logsRes.rows);
    } catch (e) {
        console.error("Error:", e.message);
    } finally {
        await pool.end();
        console.log("Done.");
    }
}
check();
