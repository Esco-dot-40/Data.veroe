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
    { id: 'dataveroe', label: 'DataVeroe Production', host: 'dataveroe-production.up.railway.app', db: 'domain-hub', filter: 'DataVeroe', logo: '📊' },
    { id: 'spell', label: 'Spelling Bee', host: 'spell.velarixsolutions.nl', db: 'spelling-bee', logo: '🐝' },
    { id: 'farkle', label: 'Farkle', host: 'farkle.velarixsolutions.nl', db: 'farkle-staging', logo: '🎲' },
    { id: 'more', label: 'More Veroe', host: 'more.veroe.fun', db: 'domain-hub', filter: 'MoreVeroe', logo: '💡' },
    { id: 'veroe-fun', label: 'Veroe Fun', host: 'veroe.fun', db: 'nexus-creative-tech', logo: '✨' },
    { id: 'veroe-space', label: 'Veroe Space', host: 'veroe.space', db: 'nexus-creative-tech', logo: '🌌' },
    { id: 'me', label: 'Veroe Me', host: 'me.veroe.fun', db: 'domain-hub', filter: 'VeroeMe', logo: '👤' },
    { id: 'tnt', label: 'TNT Veroe', host: 'tnt.veroe.fun', db: 'domain-hub', filter: 'TNTVeroe', logo: '💣' },
    { id: 'velarix', label: 'Velarix Solutions', host: 'velarixsolutions.nl', db: 'domain-hub', filter: 'Velarix', logo: '🛡️' },
    { id: 'linkex', label: 'Linkex Production', host: 'linkex-production.up.railway.app', db: 'link.veroe.space', logo: '🔗' },
    { id: 'dirty', label: 'Dirty Veroe', host: 'dirty.veroe.fun', db: 'domain-hub', filter: 'DirtyVeroe', logo: '🔞' },
    { id: 'spoti', label: 'Spoti Veroe', host: 'spoti.veroe.fun', db: 'domain-hub', filter: 'SpotiVeroe', logo: '🎵' },
    { id: 'squareup', label: 'Square Up Velarix', host: 'squareup.velarixsolutions.nl', db: 'domain-hub', filter: 'SquareUp', logo: '🟩' }
];

const pools = {};
dbConfigs.forEach(config => {
    const connectionString = (process.env[config.envKey] || '').trim();
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

function getGeo(ip) {
    return new Promise((resolve) => {
        const http = require('http');
        // fallback handles local IPs
        if (ip === '::1' || ip === '127.0.0.1') return resolve({});
        http.get(`http://ip-api.com/json/${ip}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
            });
        }).on('error', () => resolve({}));
    });
}

// 1. Tracking Script Endpoint (Serve Script)
app.get('/api/track.js', (req, res) => {
    const site = req.query.site || 'unknown';
    res.setHeader('Content-Type', 'application/javascript');
    const host = req.get('host');
    const protocol = req.protocol;
    res.send(`
(function() {
    const data = {
        site_label: "${site}",
        referrer: document.referrer,
        screen_res: \`\${window.screen.width}x\${window.screen.height}\`,
        language: navigator.language
    };
    fetch("${protocol}://${host}/api/track", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(e => console.error("Track Error:", e));
})();
    `);
});

// 2. Tracking Endpoint (Receive Posts)
app.post('/api/track', async (req, res) => {
    const { site_label, referrer, screen_res, language } = req.body;
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();

    try {
        const geo = await getGeo(ip);
        const pool = pools['domain-hub'];
        if (!pool) return res.status(500).send('Database Node Offline');

        const query = `
            INSERT INTO visitor_logs 
            (timestamp, site_label, ip, city, region, country, country_code, isp, lat, lon, timezone, user_agent, screen_res, referrer, language, zip, org)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `;
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
            req.headers['user-agent'] || '',
            screen_res || '',
            referrer || '',
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
                `SELECT timestamp, ip, city, region, country_code, user_agent, referrer, lat, lon FROM visitor_logs WHERE site_label = $1 ORDER BY timestamp DESC LIMIT 150`, 
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
                    const result = await specificPool.query(`SELECT timestamp, ip, city, region, country_code, user_agent, referrer, lat, lon FROM visitor_logs ORDER BY timestamp DESC LIMIT 150`);
                    rows = rows.concat(result.rows);
                } else if (siteConfig.db === 'farkle-staging') {
                    const result = await specificPool.query(`SELECT MAX(timestamp) as timestamp, ip_address as ip, city, region, country_code, user_agent, '' as referrer, 0 as lat, 0 as lon FROM users GROUP BY ip_address, city, region, country_code, user_agent ORDER BY timestamp DESC LIMIT 150`);
                    rows = rows.concat(result.rows);
                } else if (siteConfig.db === 'link.veroe.space') {
                    const result = await specificPool.query(`SELECT timestamp, ip, city, region, country_code, user_agent, referrer, lat, lon FROM pixel_hits ORDER BY timestamp DESC LIMIT 150`);
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
                if (r.site_label && r.site_label !== 'Default' && !SITE_MAP.some(s => s.filter === r.site_label || s.id === r.site_label)) {
                    dynamicSites.push({
                        id: r.site_label,
                        label: r.site_label,
                        host: 'Auto-Discovered',
                        db: 'domain-hub',
                        filter: r.site_label,
                        logo: '📡'
                    });
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

app.get('/', (req, res) => {
    const siteMapJson = JSON.stringify(SITE_MAP);
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Veroix Analytics Central</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <style>
        :root {
            --bg: #050508;
            --sidebar-bg: rgba(10, 10, 15, 0.85);
            --card-bg: rgba(20, 20, 25, 0.5);
            --primary: #00f5ff;
            --secondary: #7000ff;
            --success: #00ff88;
            --error: #ff3e3e;
            --text: #e1e1e6;
            --text-dim: #8a8a93;
            --glass-border: rgba(255, 255, 255, 0.05);
        }

        * { box-sizing: border-box; }
        body {
            background: var(--bg);
            color: var(--text);
            font-family: 'Inter', sans-serif;
            margin: 0; padding: 0; min-height: 100vh;
            display: flex;
            background-image: radial-gradient(circle at 10% 10%, #170724, transparent), 
                              radial-gradient(circle at 90% 90%, #031525, transparent);
        }

        /* Layout */
        .app-shell { display: flex; width: 100vw; height: 100vh; overflow: hidden; }

        /* Sidebar */
        .sidebar {
            width: 280px;
            background: var(--sidebar-bg);
            border-right: 1px solid var(--glass-border);
            display: flex; flex-direction: column;
            backdrop-filter: blur(20px);
            z-index: 50;
        }
        .sidebar-header {
            padding: 2rem 1.5rem;
            border-bottom: 1px solid var(--glass-border);
        }
        .sidebar-header h1 {
            font-family: 'Orbitron', sans-serif;
            font-size: 1.1rem; letter-spacing: 2px;
            background: linear-gradient(90deg, #fff, var(--primary));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            margin: 0;
        }
        .site-list { flex: 1; overflow-y: auto; padding: 1rem 0; }
        .site-item {
            padding: 0.85rem 1.5rem;
            display: flex; align-items: center; gap: 0.75rem;
            cursor: pointer; transition: all 0.2s;
            border-left: 3px solid transparent;
            font-size: 0.9rem;
        }
        .site-item:hover { background: rgba(255,255,255,0.03); }
        .site-item.active {
            background: rgba(0, 245, 255, 0.08);
            border-left-color: var(--primary);
            color: #fff; font-weight: 600;
        }
        .site-icon { font-size: 1.1rem; }

        /* Main Content */
        .main-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .top-bar {
            padding: 1.5rem 2rem;
            border-bottom: 1px solid var(--glass-border);
            display: flex; justify-content: space-between; align-items: center;
        }
        .tab-bar { display: flex; gap: 0.5rem; }
        .tab-btn {
            background: rgba(255,255,255,0.05);
            border: 1px solid var(--glass-border);
            color: var(--text-dim);
            padding: 0.5rem 1rem; border-radius: 0.5rem;
            cursor: pointer; font-size: 0.8rem; font-weight: 600;
            transition: all 0.2s;
        }
        .tab-btn.active {
            background: var(--primary); color: #000;
            border-color: var(--primary);
        }

        /* View Frames */
        .view-container { flex: 1; position: relative; overflow: hidden; }
        .view {
            position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            display: none; flex-direction: column; padding: 2rem;
        }
        .view.active { display: flex; }

        /* Map View */
        #map { flex: 1; border-radius: 1rem; border: 1px solid var(--glass-border); background: #1a1a1a; }

        /* Logs View */
        .logs-table-wrap {
            flex: 1; overflow-y: auto; border: 1px solid var(--glass-border);
            border-radius: 1rem; background: var(--card-bg);
            backdrop-filter: blur(10px);
        }
        table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem; }
        th { padding: 1rem; background: rgba(0,0,0,0.3); color: var(--primary); font-family: 'Orbitron'; font-size: 0.75rem; }
        td { padding: 0.85rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.02); }
        tr:hover { background: rgba(255,255,255,0.01); }

        /* Installer View */
        .code-box {
            background: #09090c; padding: 1.5rem; border-radius: 0.75rem;
            border: 1px solid rgba(0, 245, 255, 0.2); font-family: monospace;
            color: var(--primary); font-size: 0.9rem; overflow-x: auto;
            position: relative; white-space: pre-wrap;
        }

        /* Statuses */
        .badge {
            font-size: 0.65rem; padding: 0.2rem 0.5rem; border-radius: 0.5rem;
            background: rgba(0, 255, 136, 0.1); color: var(--success);
            border: 1px solid rgba(0, 255, 136, 0.2); margin-left: auto;
        }
        .badge.offline { background: rgba(255,62,62,0.1); color: var(--error); border-color: rgba(255,62,62,0.2); }
    </style>
</head>
<body>
    <div class="app-shell">
        <div class="sidebar">
            <div class="sidebar-header">
                <h1>VEROIX CORE</h1>
            </div>
            <div class="site-list" id="site-list">
                <!-- Site mapping injected here -->
            </div>
        </div>

        <div class="main-content">
            <div class="top-bar">
                <div>
                    <h2 id="active-title" style="margin:0; font-family: 'Orbitron'; font-size: 1.2rem;">Select Node</h2>
                    <span id="active-host" style="font-size:0.75rem; color: var(--text-dim);">Unselected</span>
                </div>
                <div class="tab-bar">
                    <button class="tab-btn active" onclick="switchTab('heatmap')">Heatmap</button>
                    <button class="tab-btn" onclick="switchTab('logs')">Detailed Logs</button>
                    <button class="tab-btn" onclick="switchTab('installer')">Incorporate Code</button>
                </div>
            </div>

            <div class="view-container">
                <!-- Heatmap -->
                <div id="view-heatmap" class="view active">
                    <div id="map"></div>
                </div>

                <!-- Logs -->
                <div id="view-logs" class="view">
                    <div class="logs-table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>Timestamp</th>
                                    <th>IP / Client</th>
                                    <th>Location</th>
                                    <th>Route / Referrer</th>
                                </tr>
                            </thead>
                            <tbody id="logs-body">
                                <tr><td colspan="4" style="text-align:center;color:var(--text-dim)">Pinging database node...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Installer -->
                <div id="view-installer" class="view">
                    <h3>Incorporate Analytics Engine</h3>
                    <p style="font-size: 0.9rem; color: var(--text-dim);">Copy and paste this snippet into the <code>&lt;head&gt;</code> of the target site to populate logs and heatmap data into this project dashboard.</p>
                    <div class="code-box" id="code-snippet">Loading...</div>
                </div>
            </div>
        </div>
    </div>

    <!-- Leaflet with fallback support -->
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>

    <script>
        let SITES = [];
        let currentSite = null;
        let map, heatLayer;
        let activeTab = 'heatmap';

        async function init() {
            try {
                const res = await fetch('/api/sites');
                SITES = await res.json();
                renderSidebar();
                initMap();
                if (SITES.length > 0) loadSite(SITES.length > 1 ? SITES[1].id : SITES[0].id);
            } catch (e) {
                console.error("Sites load error", e);
            }
        }

        function renderSidebar() {
            const list = document.getElementById('site-list');
            list.innerHTML = SITES.map(s => \`
                <div id="item-\${s.id}" class="site-item" onclick="loadSite('\${s.id}')">
                    <span class="site-icon">\${s.logo}</span>
                    <span>\${s.label}</span>
                    <span class="badge" id="badge-\${s.id}">Online</span>
                </div>
            \`).join("");
        }

        function initMap() {
            map = L.map('map').setView([20, 0], 2);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap &copy; CARTO'
            }).addTo(map);
        }

        function switchTab(tab) {
            activeTab = tab;
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');

            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('view-' + tab).classList.add('active');

            if (tab === 'heatmap') setTimeout(() => map.invalidateSize(), 200);
        }

        async function loadSite(siteId) {
            currentSite = SITES.find(s => s.id === siteId);
            document.getElementById('active-title').innerText = currentSite.label;
            document.getElementById('active-host').innerText = currentSite.host;
            
            document.querySelectorAll('.site-item').forEach(i => i.classList.remove('active'));
            document.getElementById('item-' + siteId).classList.add('active');

            document.getElementById('code-snippet').innerText = \`<!-- Veroix Analytics Core -->\n<script src="\${window.location.origin}/api/track.js?site=\${currentSite.id}"><\\/script>\`;

            fetchLogs(siteId);
        }

        async function fetchLogs(siteId) {
            const tbody = document.getElementById('logs-body');
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Synchronizing Node Logs...</td></tr>';
            
            if (heatLayer) map.removeLayer(heatLayer);

            try {
                const res = await fetch(\`/api/logs?site=\${siteId}\`);
                const data = await res.json();
                
                if (data.message) {
                    tbody.innerHTML = \`<tr><td colspan="4" style="text-align:center; color: var(--error);">\${data.message}</td></tr>\`;
                    return;
                }

                if (!Array.isArray(data) || data.length === 0) {
                     tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Logs clean. No hits streamed under this node profile.</td></tr>';
                     return;
                }

                // Render Logs Table
                tbody.innerHTML = data.map(log => \`
                    <tr>
                        <td>\${new Date(log.timestamp).toLocaleString()}</td>
                        <td><span style="color:var(--primary)">\${log.ip || 'Unknown'}</span></td>
                        <td>\${log.city || ''}, \${log.country_code || 'N/A'}</td>
                        <td>\${log.referrer ? \`<a href="\${log.referrer}" target="_blank" style="color:#70ffb5;text-decoration:none;">Referrer</a>\` : 'Direct'} \${log.user_agent ? \`<span style="display:block;font-size:0.65rem;color:var(--text-dim);">\${log.user_agent.substring(0,40)}...</span>\` : ''}</td>
                    </tr>
                \`).join("");

                // Render Heatmap Coords
                const points = data
                    .filter(l => l.lat && l.lon)
                    .map(l => [parseFloat(l.lat), parseFloat(l.lon), 0.5]);

                if (points.length > 0) {
                     heatLayer = L.heatLayer(points, { radius: 25, blur: 15, maxZoom: 10 }).addTo(map);
                }

            } catch (err) {
                tbody.innerHTML = \`<tr><td colspan="4" style="text-align:center; color: var(--error);">Fetch Fail: \${err.message}</td></tr>\`;
            }
        }

        window.onload = init;
    </script>
</body>
</html>
    `);
});

app.listen(PORT, async () => {
    console.log('🚀 Analytics Central running on port ' + PORT);
    await runAggregator(); 
});

