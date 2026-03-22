const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const { Pool } = require('pg');
const helmet = require('helmet');
const cors = require('cors');
const { runAggregator, getStats } = require('./aggregator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const adminUser = (process.env.ADMIN_USER || 'admin').replace(/['"]/g, '').trim();
const adminPass = (process.env.ADMIN_PASS || 'password').replace(/['"]/g, '').trim();

console.log(`[Auth] Initializing with user: "${adminUser}"`);

// Manual Basic Auth Middleware for better reliability on Railway
app.use((req, res, next) => {
    if (req.path === '/api/track.js' || req.path === '/api/track') {
        return next();
    }

    const auth = req.headers.authorization;
    if (!auth) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Veroix Analytics Central"');
        return res.status(401).send('Authentication required');
    }

    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    const [u, p] = credentials;

    if (u === adminUser && p === adminPass) {
        return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Veroix Analytics Central"');
    res.status(401).send('Invalid credentials');
});



const dbConfigs = [
    { name: 'domain-hub', envKey: 'DB_DOMAIN_HUB_URL' },
    { name: 'farkle-staging', envKey: 'DB_FARKLE_STAGING_URL' },
    { name: 'link.veroe.space', envKey: 'DB_LINK_VEROE_SPACE_URL' },
    { name: 'nexus-creative-tech', envKey: 'DB_NEXUS_CREATIVE_URL' },
    { name: 'spelling-bee', envKey: 'DB_SPELLING_BEE_URL' }
];

const SITE_MAP = [
    { id: 'dataveroe', label: 'DataVeroe Production', host: 'dataveroe-production.up.railway.app', db: 'domain-hub', filter: 'DataVeroe' },
    { id: 'spell', label: 'Spelling Bee', host: 'spell.velarixsolutions.nl', db: 'spelling-bee' },
    { id: 'farkle', label: 'Farkle', host: 'farkle.velarixsolutions.nl', db: 'farkle-staging' },
    { id: 'more', label: 'More Veroe', host: 'more.veroe.fun', db: 'domain-hub', filter: 'MoreVeroe' },
    { id: 'veroe-fun', label: 'Veroe Fun', host: 'veroe.fun', db: 'nexus-creative-tech' },
    { id: 'veroe-space', label: 'Veroe Space', host: 'veroe.space', db: 'nexus-creative-tech' },
    { id: 'me', label: 'Veroe Me', host: 'me.veroe.fun', db: 'domain-hub', filter: 'VeroeMe' },
    { id: 'tnt', label: 'TNT Veroe', host: 'tnt.veroe.fun', db: 'domain-hub', filter: 'TNTVeroe' },
    { id: 'velarix', label: 'Velarix Solutions', host: 'velarixsolutions.nl', db: 'domain-hub', filter: 'Velarix' },
    { id: 'linkex', label: 'Linkex Production', host: 'linkex-production.up.railway.app', db: 'link.veroe.space' },
    { id: 'dirty', label: 'Dirty Veroe', host: 'dirty.veroe.fun', db: 'domain-hub', filter: 'DirtyVeroe' },
    { id: 'spoti', label: 'Spoti Veroe', host: 'spoti.veroe.fun', db: 'domain-hub', filter: 'SpotiVeroe' },
    { id: 'squareup', label: 'Square Up Velarix', host: 'squareup.velarixsolutions.nl', db: 'domain-hub', filter: 'SquareUp' }
];

const pools = {};
dbConfigs.forEach(config => {
    const connectionString = (process.env[config.envKey] || (config.name === 'domain-hub' ? process.env.DATABASE_URL : '') || '').trim();
    if (connectionString) {
        pools[config.name] = new Pool({ 
            connectionString, 
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000 
        });
        console.log(`✅ Initialized pool for ${config.name}`);
    } else {
        console.warn(`⚠️  Missing environment variable for ${config.name} (${config.envKey})`);
    }
});

// 1. Tracking Script Endpoint (Serve Script)
app.get('/api/track.js', (req, res) => {
    const siteId = req.query.site || 'unknown';
    const host = req.get('host');
    const protocol = req.protocol; // on railway usually http over external https

    const script = `(function() {
        function sendVerTrack() {
            const data = {
                site_label: "${siteId}",
                referrer: document.referrer || '',
                screen_res: window.screen.width + "x" + window.screen.height,
                language: navigator.language || navigator.userLanguage,
                path: window.location.pathname
            };
            fetch("${protocol}://${host}/api/track", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).catch(e => console.error("Track Error:", e));
        }

        sendVerTrack();

        // SPA Navigation interceptor
        const pushState = history.pushState;
        history.pushState = function() {
            pushState.apply(history, arguments);
            setTimeout(sendVerTrack, 100);
        };
        window.addEventListener('popstate', sendVerTrack);
    })();`;
    res.type('application/javascript').send(script);
});

async function getGeo(ip) {
    try {
        if (ip === '::1' || ip === '127.0.0.1') return {};
        const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
        const geo = await response.json();
        return geo.status === 'success' ? geo : {};
    } catch(e) { return {}; }
}

// 2. Tracking Endpoint (Receive Posts)
app.post('/api/track', async (req, res) => {
    const { site_label, referrer, screen_res, language, path } = req.body;
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();

    try {
        const geo = await getGeo(ip);
        const pool = pools['domain-hub'];
        if (!pool) return res.status(500).json({ error: 'Database Node Offline' });

        const user_agent = req.headers['user-agent'] || '';

        const query = `
            INSERT INTO visitor_logs (
                timestamp, site_label, ip, city, region, country, country_code, isp, lat, lon, timezone, user_agent, screen_res, referrer, language, zip, org
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
            )
        `;
        
        const trueReferrer = path ? `${referrer || ''} [${path}]` : referrer;

        const values = [
            new Date(),
            site_label || 'Default',
            ip,
            geo.city || '',
            geo.regionName || '',
            geo.country || '',
            geo.countryCode || '',
            geo.isp || '',
            parseFloat(geo.lat) || 0,
            parseFloat(geo.lon) || 0,
            geo.timezone || '',
            user_agent,
            screen_res || '',
            trueReferrer,
            language || '',
            geo.zip || '',
            geo.org || ''
        ];

        await pool.query(query, values);
        res.json({ success: true });
    } catch (e) {
        console.error("Tracking Record Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// 3. Raw Logs Query Router
app.get('/api/logs', async (req, res) => {
    const { site } = req.query;
    let siteConfig = SITE_MAP.find(s => s.id === site);
    
    // Fallback if not mapped natively
    if (!siteConfig) {
         siteConfig = { id: site, db: 'domain-hub', filter: site };
    }

    let rows = [];

    // 1. Fetch from Centralized Domain-Hub Tracker (Where all new snippets are logging)
    try {
        const poolHub = pools['domain-hub'];
        if (poolHub) {
            const result = await poolHub.query(
                `SELECT timestamp, ip, city, region, country_code, user_agent, referrer, lat, lon, isp, org, screen_res FROM visitor_logs WHERE site_label = $1 ORDER BY timestamp DESC LIMIT 150`, 
                [siteConfig.filter || siteConfig.id]
            );
            rows = rows.concat(result.rows);
        }
    } catch (err) {
        console.error("Central Hub Logs fetch failed:", err.message);
    }

    // 2. Fetch from Dedicated Historical DB (If it exists and is online)
    if (siteConfig.db !== 'domain-hub') {
        try {
            const specificPool = pools[siteConfig.db];
            if (specificPool) {
                if (siteConfig.db === 'nexus-creative-tech') {
                    const result = await specificPool.query(`SELECT timestamp, query as ip, city, region_name as region, country_code, user_agent, referrer, lat, lon FROM analytics_events ORDER BY timestamp DESC LIMIT 150`);
                    rows = rows.concat(result.rows);
                } else if (siteConfig.db === 'spelling-bee') {
                    const result = await specificPool.query(`SELECT timestamp, ip, city, region, country as country_code, user_agent, referrer, lat, lng as lon FROM visitor_logs ORDER BY timestamp DESC LIMIT 150`);
                    rows = rows.concat(result.rows);
                } else if (siteConfig.db === 'link.veroe.space') {
                    const result = await specificPool.query(`SELECT timestamp, ip, city, region, country as country_code, ua as user_agent, '' as referrer, 0 as lat, 0 as lon FROM pixel_hits ORDER BY timestamp DESC LIMIT 150`);
                    rows = rows.concat(result.rows);
                }
            }
        } catch (err) {
            console.error(`Historical Logs fetch failed for ${siteConfig.db}:`, err.message);
        }
    }

    // Sort combined rows by timestamp descendant
    rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Trim to 200 items maximum to prevent overload
    if (rows.length > 200) rows = rows.slice(0, 200);

    res.json(rows);
});

// 4. Fetch Active Configured and Dynamic Domains
app.get('/api/sites', async (req, res) => {
    const pool = pools['domain-hub'];
    const dynamicSites = [];
    if (pool) {
        try {
            const { rows } = await pool.query('SELECT DISTINCT site_label FROM visitor_logs');
            rows.forEach(r => {
                const label = (r.site_label || '').trim();
                if (label && label !== 'Default') {
                    const isDup = SITE_MAP.some(s => 
                        (s.filter && s.filter.toLowerCase() === label.toLowerCase()) || 
                        (s.id && s.id.toLowerCase() === label.toLowerCase()) ||
                        (s.label && s.label.toLowerCase() === label.toLowerCase())
                    );
                    if (!isDup) {
                        dynamicSites.push({
                            id: label,
                            label: label,
                            host: 'Auto-Discovered',
                            db: 'domain-hub',
                            filter: label,
                            logo: '📡'
                        });
                    }
                }
            });
        } catch(e) { console.error("Dynamic site fetch:", e.message) }
    }
    
    res.json([...SITE_MAP, ...dynamicSites]);
});

app.get('/api/stats', async (req, res) => {
    const health = await Promise.all(dbConfigs.map(async config => {
        const pool = pools[config.name];
        if (!pool) return { name: config.name, status: 'Missing Config', latency: null };
        const start = Date.now();
        try {
            await pool.query('SELECT 1');
            return { name: config.name, status: 'Online', latency: (Date.now() - start) + 'ms' };
        } catch (error) {
            return { name: config.name, status: 'Offline', error: error.message };
        }
    }));

    const aggregated = getStats();
    const combined = health.map(h => {
        const aggr = aggregated[h.name] || {};
        return { ...h, ...aggr, status: h.status === 'Online' ? (aggr.status || 'Online') : h.status };
    });
    res.json(combined);
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

;

app.listen(PORT, async () => {
    console.log('🚀 Analytics Central running on port ' + PORT);
    await runAggregator(); 
});

