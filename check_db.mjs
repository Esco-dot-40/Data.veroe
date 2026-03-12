
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const sources = [
    { name: 'domain-hub', envKey: 'DB_DOMAIN_HUB_URL' },
    { name: 'farkle-staging', envKey: 'DB_FARKLE_STAGING_URL' },
    { name: 'link.veroe.space', envKey: 'DB_LINK_VEROE_SPACE_URL' },
    { name: 'nexus-creative-tech', envKey: 'DB_NEXUS_CREATIVE_URL' },
    { name: 'spelling-bee', envKey: 'DB_SPELLING_BEE_URL' }
];

async function check() {
    for (const source of sources) {
        const url = process.env[source.envKey];
        if (!url) {
            console.log(`${source.name}: Missing URL`);
            continue;
        }
        const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
        try {
            console.log(`Checking ${source.name}...`);
            const tablesRes = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tablesRes.rows.map(r => r.table_name);
            console.log(`  Tables: ${tables.join(', ')}`);
            
            for (const table of tables) {
                const countRes = await pool.query(`SELECT COUNT(*) FROM "${table}"`);
                console.log(`  - ${table}: ${countRes.rows[0].count}`);
            }
        } catch (e) {
            console.error(`  Error: ${e.message}`);
        } finally {
            await pool.end();
        }
    }
}

check();
