const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const { Pool } = require('pg');
const helmet = require('helmet');
const cors = require('cors');
const { runAggregator, getStats } = require('./aggregator');

const app = express();
const PORT = process.env.PORT || 3000;

const cookieParser = require('cookie-parser');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(cookieParser());

const ACCOUNTS = [
    {
        user: (process.env.ADMIN_USER || 'admin').replace(/['"]/g, '').trim(),
        pass: (process.env.ADMIN_PASS || 'password').replace(/['"]/g, '').trim(),
        secret: process.env.TWO_FACTOR_SECRET
    },
    {
        user: (process.env.ADMIN_USER_2 || 'admin2').replace(/['"]/g, '').trim(),
        pass: (process.env.ADMIN_PASS_2 || 'password').replace(/['"]/g, '').trim(),
        secret: process.env.TWO_FACTOR_SECRET_2
    },
    {
        user: (process.env.ADMIN_USER_3 || 'admin3').replace(/['"]/g, '').trim(),
        pass: (process.env.ADMIN_PASS_3 || 'password').replace(/['"]/g, '').trim(),
        secret: process.env.TWO_FACTOR_SECRET_3
    }
];

const VALID_SESSIONS = new Map(); // token => { username, db_match, needs_2fa }

// 1. Setup 2FA Flow (Automated Save into Database)
app.get('/setup-2fa', async (req, res) => {
    const cToken = req.cookies.auth_token;
    if (!cToken || !VALID_SESSIONS.has(cToken)) return res.redirect('/login');

    const sessionData = VALID_SESSIONS.get(cToken);
    const pool = pools['domain-hub'];

    let existingSecret = null;

    // Check if account already has established 2FA to prevent overload mismatch
    if (pool) {
        try {
            const { rows } = await pool.query('SELECT two_factor_secret FROM admin_users WHERE username = $1', [sessionData.username]);
            if (rows.length > 0 && rows[0].two_factor_secret) {
                existingSecret = rows[0].two_factor_secret;
            }
        } catch (e) { console.error("2FA Check Error:", e.message); }
    }

    let secret;
    if (existingSecret) {
        secret = { 
            base32: existingSecret, 
            otpauth_url: `otpauth://totp/Veroix Analytics Central (${sessionData.username})?secret=${existingSecret}&issuer=Veroix`
        };
    } else {
        secret = speakeasy.generateSecret({ name: 'Veroix Analytics Central (' + sessionData.username + ')' });
        if (pool && sessionData.db_match) {
            try {
                await pool.query('UPDATE admin_users SET two_factor_secret = $1 WHERE username = $2', [secret.base32, sessionData.username]);
                sessionData.needs_2fa = false; // Resolved
                VALID_SESSIONS.set(cToken, sessionData);
            } catch (e) {
                return res.send("DB Sync Error: " + e.message);
            }
        }
    }

    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);
    const html = fs.readFileSync(__dirname + '/setup.html', 'utf8')
                .replace('{{QR_IMG}}', qrCodeUrl)
                .replace('{{SECRET_KEY}}', secret.base32);
    res.send(html);
});

// 2. Login UI
app.get('/login', (req, res) => {
    if (req.cookies.auth_token && VALID_SESSIONS.has(req.cookies.auth_token)) {
        const session = VALID_SESSIONS.get(req.cookies.auth_token);
        if (!session.needs_2fa) return res.redirect('/');
    }
    res.sendFile(__dirname + '/login.html');
});

// 3. Login Verification API
app.post('/api/auth', async (req, res) => {
    const { user, pass, token } = req.body;
    const pool = pools['domain-hub'];

    let account = null;

    // Database lookup first
    if (pool) {
        try {
            const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1 AND password = $2', [user, pass]);
            if (rows.length > 0) {
                account = { user: rows[0].username, pass: rows[0].password, secret: rows[0].two_factor_secret, db: true };
            }
        } catch (e) { console.error("DB Auth error:", e.message); }
    }

    // Fallback to Env Arrays
    if (!account) {
        account = ACCOUNTS.find(a => a.user === user && a.pass === pass);
    }

    if (!account) return res.status(401).json({ error: 'Identity rejected' });

    // Validate 2FA TOTP token if secret exists
    const hasSecret = !!account.secret;
    if (hasSecret) {
        const verified = speakeasy.totp.verify({
            secret: account.secret,
            encoding: 'base32',
            token: token
        });
        if (!verified) return res.status(401).json({ error: 'Token invalid' });
    }

    const sess = crypto.randomBytes(32).toString('hex');
    const needs_2fa = account.db && !hasSecret;
    
    VALID_SESSIONS.set(sess, { username: account.user, db_match: !!account.db, needs_2fa });
    res.cookie('auth_token', sess, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    
    // Response with correct context
    res.json({ success: true, redirect: needs_2fa ? '/setup-2fa' : '/' });
});

// 4. Primary System Interceptor (Zero-Trust Model)
app.use((req, res, next) => {
    if (req.path === '/api/track.js' || req.path === '/api/track') return next();

    const cToken = req.cookies.auth_token;
    if (cToken && VALID_SESSIONS.has(cToken)) {
        const session = VALID_SESSIONS.get(cToken);
        
        // If they logged in without a 2FA profile set up, force them to do so immediately
        if (session.needs_2fa && req.path !== '/setup-2fa') {
            return res.redirect('/setup-2fa');
        }
        return next();
    }

    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication Required' });
    
    res.redirect('/login');
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

// 0. Auto-Seed Master Account to Database if empty
async function seedMasterAccount() {
    const pool = pools['domain-hub'];
    if (!pool) return;
    try {
        const { rows } = await pool.query('SELECT COUNT(*) FROM admin_users');
        if (parseInt(rows[0].count) === 0) {
            console.log("🌱 Database is empty. Seeding master account variables into Admin table...");
            const master = ACCOUNTS[0];
            await pool.query('INSERT INTO admin_users (username, password) VALUES ($1, $2)', [master.user, master.pass]);
            console.log("✅ Master account seeded successfully.");
        }
    } catch (e) {
        console.error("⚠️  Failed to seed master account:", e.message);
    }
}
setTimeout(seedMasterAccount, 3000); // Wait for pool fully initializing

// 0. Account Creation Endpoint (Authenticated Admins ONLY)
app.post('/api/admin/users/create', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !username.trim() || !password || !password.trim()) return res.status(400).json({ error: "Missing fields" });

    const pool = pools['domain-hub'];
    if (!pool) return res.status(500).json({ error: "Database offline" });

    try {
        await pool.query('INSERT INTO admin_users (username, password) VALUES ($1, $2)', [username.trim(), password.trim()]);
        res.json({ success: true, message: "User added! They can log in and setup 2FA independently." });
    } catch (e) {
        if (e.message.includes('unique_violation') || e.message.includes('duplicate')) return res.status(400).json({ error: "Username already exists" });
        res.status(500).json({ error: e.message });
    }
});
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

