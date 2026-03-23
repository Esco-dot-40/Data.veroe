const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DB_DOMAIN_HUB_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    try {
        console.log("Checking and Creating admin_users table...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                two_factor_secret TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Table created successfully!");
    } catch (e) {
        console.error("Setup error:", e.message);
    } finally {
        await pool.end();
    }
}

main();
