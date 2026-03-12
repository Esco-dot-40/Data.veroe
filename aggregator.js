const cron = require('node-cron');
const { Pool } = require('pg');
require('dotenv').config();


const sources = [
    { name: 'domain-hub', envKey: 'DB_DOMAIN_HUB_URL' },
    { name: 'farkle-staging', envKey: 'DB_FARKLE_STAGING_URL' },
    { name: 'link.veroe.space', envKey: 'DB_LINK_VEROE_SPACE_URL' },
    { name: 'nexus-creative-tech', envKey: 'DB_NEXUS_CREATIVE_URL' },
    { name: 'spelling-bee', envKey: 'DB_SPELLING_BEE_URL' }
];

let globalStats = {};

async function runAggregator() {
    console.log(`[${new Date().toISOString()}] Aggregating stats from ${sources.length} sources...`);
    const newStats = {};

    for (const source of sources) {
        const url = process.env[source.envKey];
        if (!url) continue;

        const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
        try {
            const tablesRes = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tablesRes.rows.map(r => r.table_name);
            
            let sourceData = { name: source.name, tables, totalVisits: 0, blockedVisits: 0, lastVisit: null };

            if (tables.includes('page_accesses')) {
                const res = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN isBlocked = 1 THEN 1 ELSE 0 END) as blocked, MAX(timestamp) as last FROM page_accesses');
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.blockedVisits = parseInt(res.rows[0].blocked) || 0;
                sourceData.lastVisit = res.rows[0].last;
            } else if (tables.includes('visitor_logs')) {
                const res = await pool.query('SELECT COUNT(*) as total, MAX(timestamp) as last FROM visitor_logs');
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.lastVisit = res.rows[0].last;
            } else if (tables.includes('analytics_events')) {
                const res = await pool.query('SELECT COUNT(*) as total, MAX(timestamp) as last FROM analytics_events');
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.lastVisit = res.rows[0].last;
            } else if (tables.includes('pixel_hits')) {
                const res = await pool.query('SELECT COUNT(*) as total, MAX(timestamp) as last FROM pixel_hits');
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.lastVisit = res.rows[0].last;
            } else if (tables.includes('user_stats')) {
                const res = await pool.query('SELECT SUM(games_played) as total, MAX(last_played_date) as last FROM user_stats');
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.lastVisit = res.rows[0].last;
            }


            newStats[source.name] = sourceData;
            console.log(`✅ Aggregated ${source.name}: ${sourceData.totalVisits} visits`);
        } catch (err) {
            console.error(`❌ ${source.name} aggregation failed: ${err.message}`);
        } finally {
            await pool.end();
        }
    }

    globalStats = newStats;
    return globalStats;
}

// Run every 15 minutes
cron.schedule('*/15 * * * *', runAggregator);

module.exports = { runAggregator, getStats: () => globalStats };

