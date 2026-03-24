const { Pool } = require('pg');

async function reset() {
    const pool = new Pool({ connectionString: "postgresql://postgres:PtQjNrHokGwYhufhXxpeITFgZkPvTGyp@shuttle.proxy.rlwy.net:55212/railway" });
    
    try {
        await pool.query('UPDATE admin_users SET two_factor_secret = NULL WHERE username = $1', ['admin']);
        console.log("✅ 2FA Reset to NULL successful!");
        
        const r = await pool.query('SELECT two_factor_secret FROM admin_users WHERE username = $1', ['admin']);
        console.log("Current Secret:", r.rows[0].two_factor_secret);
    } catch (e) {
        console.error("Database Error:", e);
    } finally {
        await pool.end();
    }
}

reset();
