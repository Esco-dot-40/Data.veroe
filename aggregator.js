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

            let sourceData = {
                name: source.name,
                tables,
                totalVisits: 0,
                blockedVisits: 0,
                lastVisit: null,
                metrics: {},
                status: 'Connected'
            };

            // 1. NEXUS / VEROIX Style (page_accesses or analytics_events)
            if (tables.includes('page_accesses')) {
                const res = await pool.query(`
                    SELECT 
                        COUNT(*) as total, 
                        SUM(CASE WHEN isBlocked = 1 THEN 1 ELSE 0 END) as blocked, 
                        MAX(timestamp) as last,
                        COUNT(DISTINCT ip) as unique_ips
                    FROM page_accesses
                `);
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.blockedVisits = parseInt(res.rows[0].blocked) || 0;
                sourceData.lastVisit = res.rows[0].last;
                sourceData.metrics.unique_ips = parseInt(res.rows[0].unique_ips);
            }
            else if (tables.includes('analytics_events')) {
                const res = await pool.query(`
                    SELECT 
                        COUNT(*) as total, 
                        MAX(timestamp) as last,
                        COUNT(DISTINCT query) as unique_ips
                    FROM analytics_events
                `);
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.lastVisit = res.rows[0].last;
                sourceData.metrics.unique_ips = parseInt(res.rows[0].unique_ips);
            }

            // 2. DISCORD / NYT Style (visitor_logs)
            else if (tables.includes('visitor_logs')) {
                const res = await pool.query('SELECT COUNT(*) as total, MAX(timestamp) as last FROM visitor_logs');
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.lastVisit = res.rows[0].last;

                // Try to get specific stats if it's the NYT app
                if (tables.includes('games')) {
                    const gameRes = await pool.query('SELECT COUNT(*) as games FROM games');
                    sourceData.metrics.games_played = parseInt(gameRes.rows[0].games);
                }
            }

            // 3. PIXEL / TRACKER Style (pixel_hits)
            else if (tables.includes('pixel_hits')) {
                const res = await pool.query('SELECT COUNT(*) as total, MAX(timestamp) as last FROM pixel_hits');
                sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                sourceData.lastVisit = res.rows[0].last;
            }

            // 4. Fallback for Static Stats (user_stats or users)
            if (sourceData.totalVisits === 0) {
                try {
                    if (tables.includes('user_stats')) {
                        const res = await pool.query('SELECT SUM(games_played) as total FROM user_stats');
                        sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                        
                        // Optional: Try to get last played date if column exists
                        const colRes = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_stats' AND column_name = 'last_played_date'`);
                        if (colRes.rows.length > 0) {
                            const lastRes = await pool.query('SELECT MAX(last_played_date) as last FROM user_stats');
                            sourceData.lastVisit = lastRes.rows[0].last;
                        }
                    } 
                    
                    if (sourceData.totalVisits === 0 && tables.includes('users')) {
                        const res = await pool.query('SELECT COUNT(*) as total FROM users');
                        sourceData.totalVisits = parseInt(res.rows[0].total) || 0;
                    }
                } catch (fallbackErr) {
                    console.warn(`  Fallback failed for ${source.name}: ${fallbackErr.message}`);
                }
            }

            // Validation: If no data found but connection OK, mark as "Idle"
            if (sourceData.totalVisits === 0) {
                sourceData.status = 'Synchronized (No Data)';
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

