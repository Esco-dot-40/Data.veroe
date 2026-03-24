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

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_USERS = parseInt(process.env.MAX_ADMIN_USERS || '10');

const ACCOUNTS = [
    {
        user: (process.env.ADMIN_USER || 'admin').replace(/['"]/g, '').trim(),
        pass: (process.env.ADMIN_PASS || 'password').replace(/['"]/g, '').trim(),
        secret: process.env.TWO_FACTOR_SECRET
    },
    {
        user: (process.env.ADMIN_USER_2 || '').replace(/['"]/g, '').trim(),
        pass: (process.env.ADMIN_PASS_2 || '').replace(/['"]/g, '').trim(),
        secret: process.env.TWO_FACTOR_SECRET_2
    },
    {
        user: (process.env.ADMIN_USER_3 || '').replace(/['"]/g, '').trim(),
        pass: (process.env.ADMIN_PASS_3 || '').replace(/['"]/g, '').trim(),
        secret: process.env.TWO_FACTOR_SECRET_3
    }
].filter(a => a.user && a.pass);

// ─── DB Pools ──────────────────────────────────────────────────────────────────
const dbConfigs = [
    { name: 'domain-hub', envKey: 'DB_DOMAIN_HUB_URL', fallbackKey: 'DATABASE_URL' },
    { name: 'farkle-staging', envKey: 'DB_FARKLE_STAGING_URL' },
    { name: 'link.veroe.space', envKey: 'DB_LINK_VEROE_SPACE_URL' },
    { name: 'nexus-creative-tech', envKey: 'DB_NEXUS_CREATIVE_URL' },
    { name: 'spelling-bee', envKey: 'DB_SPELLING_BEE_URL' }
];

const pools = {};
const poolStatus = {}; // track connection health

dbConfigs.forEach(config => {
    const connectionString = (
        process.env[config.envKey] ||
        (config.fallbackKey ? process.env[config.fallbackKey] : '') ||
        ''
    ).trim();

    if (connectionString) {
        pools[config.name] = new Pool({
            connectionString,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
            max: 5
        });
        poolStatus[config.name] = { status: 'initializing', latency: null, error: null };
        console.log(`✅ Pool initialized: ${config.name}`);
    } else {
        poolStatus[config.name] = { status: 'missing_config', latency: null, error: 'No connection string' };
        console.warn(`⚠️  Missing env var for ${config.name} (${config.envKey})`);
    }
});

// ─── DB Health Probe ───────────────────────────────────────────────────────────
async function probeAllDatabases() {
    for (const config of dbConfigs) {
        const pool = pools[config.name];
        if (!pool) continue;
        const start = Date.now();
        try {
            await pool.query('SELECT 1');
            poolStatus[config.name] = { status: 'online', latency: Date.now() - start, error: null };
        } catch (err) {
            poolStatus[config.name] = { status: 'offline', latency: null, error: err.message };
            console.error(`❌ DB probe failed for ${config.name}: ${err.message}`);
        }
    }
}

// ─── Site Map ──────────────────────────────────────────────────────────────────
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

// ─── Sessions ──────────────────────────────────────────────────────────────────
const VALID_SESSIONS = new Map(); // token => { username, db_match, needs_2fa, is_master }

// ─── Schema Bootstrap ──────────────────────────────────────────────────────────
async function bootstrapSchema() {
    const pool = pools['domain-hub'];
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                two_factor_secret TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);

        // Add missing columns gracefully
        const migrations = [
            `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`,
            `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`
        ];
        for (const sql of migrations) {
            try { await pool.query(sql); } catch (_) { }
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS visitor_logs (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMP NOT NULL,
                site_label VARCHAR(100) NOT NULL,
                ip VARCHAR(100),
                city VARCHAR(100),
                region VARCHAR(100),
                country VARCHAR(100),
                country_code VARCHAR(10),
                isp VARCHAR(150),
                lat FLOAT,
                lon FLOAT,
                timezone VARCHAR(50),
                user_agent TEXT,
                screen_res VARCHAR(50),
                referrer TEXT,
                language VARCHAR(100),
                zip VARCHAR(20),
                org VARCHAR(150)
            )
        `);

        // Index for fast site_label queries
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_visitor_logs_site_label ON visitor_logs(site_label)
        `).catch(() => { });
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_visitor_logs_timestamp ON visitor_logs(timestamp DESC)
        `).catch(() => { });

        console.log('✅ Schema bootstrapped');
    } catch (e) {
        console.error('⚠️  Schema bootstrap error:', e.message);
    }
}

// ─── Seed Master Account ───────────────────────────────────────────────────────
async function seedMasterAccount() {
    const pool = pools['domain-hub'];
    if (!pool) return;
    try {
        const master = ACCOUNTS[0];
        if (!master) return;

        const { rows } = await pool.query('SELECT COUNT(*) FROM admin_users');
        if (parseInt(rows[0].count) === 0) {
            console.log('🌱 Seeding master account...');
            await pool.query(
                'INSERT INTO admin_users (username, password) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
                [master.user, master.pass]
            );
            console.log('✅ Master account seeded');
        }
    } catch (e) {
        console.error('⚠️  Seed error:', e.message);
    }
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.path === '/api/track.js' || req.path === '/api/track') return next();

    const cToken = req.cookies.auth_token;
    if (cToken && VALID_SESSIONS.has(cToken)) {
        const session = VALID_SESSIONS.get(cToken);
        if (session.needs_2fa && req.path !== '/setup-2fa' && !req.path.startsWith('/api/auth')) {
            return req.path.startsWith('/api/')
                ? res.status(401).json({ error: '2FA setup required', redirect: '/setup-2fa' })
                : res.redirect('/setup-2fa');
        }
        req.session = session;
        return next();
    }

    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required' });
    res.redirect('/login');
}

// ─── Public Routes ─────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
    if (req.cookies.auth_token && VALID_SESSIONS.has(req.cookies.auth_token)) {
        const session = VALID_SESSIONS.get(req.cookies.auth_token);
        if (!session.needs_2fa) return res.redirect('/');
    }
    res.sendFile('login.html', { root: __dirname });
});

// ─── Auth API ──────────────────────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
    const { user, pass, token } = req.body;
    const pool = pools['domain-hub'];
    let account = null;
    let isDbAccount = false;

    // 1. Database lookup first
    if (pool) {
        try {
            const { rows } = await pool.query(
                'SELECT * FROM admin_users WHERE username = $1 AND password = $2 AND is_active = TRUE',
                [user, pass]
            );
            if (rows.length > 0) {
                account = {
                    user: rows[0].username,
                    pass: rows[0].password,
                    secret: rows[0].two_factor_secret,
                    id: rows[0].id
                };
                isDbAccount = true;
            }
        } catch (e) {
            console.error('DB auth error:', e.message);
        }
    }

    // 2. Fallback to env accounts
    if (!account) {
        const envMatch = ACCOUNTS.find(a => a.user === user && a.pass === pass);
        if (envMatch) {
            account = envMatch;
            isDbAccount = false;
        }
    }

    if (!account) return res.status(401).json({ error: 'Invalid credentials' });

    // 3. 2FA validation
    const hasSecret = !!account.secret;
    if (hasSecret) {
        if (!token) return res.status(401).json({ error: '2FA code required', needs_token: true });
        const verified = speakeasy.totp.verify({
            secret: account.secret,
            encoding: 'base32',
            token: token,
            window: 2
        });
        if (!verified) return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    // 4. Update last login
    if (isDbAccount && pool) {
        pool.query('UPDATE admin_users SET last_login = NOW() WHERE username = $1', [user]).catch(() => { });
    }

    const sess = crypto.randomBytes(32).toString('hex');
    const needs_2fa = isDbAccount && !hasSecret;

    VALID_SESSIONS.set(sess, {
        username: account.user,
        db_match: isDbAccount,
        needs_2fa,
        is_master: account.user === ACCOUNTS[0]?.user
    });

    res.cookie('auth_token', sess, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
    res.json({ success: true, redirect: needs_2fa ? '/setup-2fa' : '/' });
});

app.post('/api/auth/logout', (req, res) => {
    const cToken = req.cookies.auth_token;
    if (cToken) VALID_SESSIONS.delete(cToken);
    res.clearCookie('auth_token');
    res.json({ success: true });
});

// ─── Apply Auth Middleware (after public routes) ───────────────────────────────
app.use(requireAuth);

// ─── 2FA Setup ────────────────────────────────────────────────────────────────
app.get('/setup-2fa', async (req, res) => {
    const cToken = req.cookies.auth_token;
    if (!cToken || !VALID_SESSIONS.has(cToken)) return res.redirect('/login');

    const sessionData = VALID_SESSIONS.get(cToken);
    const pool = pools['domain-hub'];

    // Check if already has 2FA in DB
    let existingSecret = null;
    if (pool && sessionData.db_match) {
        try {
            const { rows } = await pool.query(
                'SELECT two_factor_secret FROM admin_users WHERE username = $1',
                [sessionData.username]
            );
            if (rows.length > 0 && rows[0].two_factor_secret) {
                existingSecret = rows[0].two_factor_secret;
            }
        } catch (e) {
            console.error('2FA check error:', e.message);
        }
    }

    let secret;
    if (existingSecret) {
        secret = {
            base32: existingSecret,
            otpauth_url: `otpauth://totp/Veroix:${sessionData.username}?secret=${existingSecret}&issuer=Veroix`
        };
    } else if (sessionData.temp_secret) {
        secret = {
            base32: sessionData.temp_secret,
            otpauth_url: `otpauth://totp/Veroix:${sessionData.username}?secret=${sessionData.temp_secret}&issuer=Veroix`
        };
    } else {
        const s = speakeasy.generateSecret({ name: `Veroix (${sessionData.username})` });
        secret = { base32: s.base32, otpauth_url: s.otpauth_url };
        sessionData.temp_secret = secret.base32;
        VALID_SESSIONS.set(cToken, sessionData);
    }

    try {
        const qrSvg = await qrcode.toString(secret.otpauth_url, { type: 'svg' });
        const html = fs.readFileSync(require('path').join(__dirname, 'setup.html'), 'utf8')
            .replace('{{QR_SVG}}', qrSvg)
            .replace('{{SECRET_KEY}}', secret.base32)
            .replace('{{USERNAME}}', sessionData.username);
        res.send(html);
    } catch (e) {
        res.status(500).send(`<h1>QR Generation Error</h1><pre>${e.stack}</pre>`);
    }
});

app.post('/api/auth/verify-setup', async (req, res) => {
    const cToken = req.cookies.auth_token;
    if (!cToken || !VALID_SESSIONS.has(cToken)) return res.status(401).json({ error: 'Auth required' });

    const sessionData = VALID_SESSIONS.get(cToken);
    const { token } = req.body;

    if (!sessionData.temp_secret) return res.status(400).json({ error: 'No active 2FA setup found. Please refresh the setup page.' });

    const verified = speakeasy.totp.verify({
        secret: sessionData.temp_secret,
        encoding: 'base32',
        token: token,
        window: 2
    });

    if (!verified) return res.status(400).json({ error: 'Invalid code — check your authenticator app and try again.' });

    const pool = pools['domain-hub'];
    if (pool && sessionData.db_match) {
        try {
            await pool.query(
                'UPDATE admin_users SET two_factor_secret = $1 WHERE username = $2',
                [sessionData.temp_secret, sessionData.username]
            );
        } catch (e) {
            return res.status(500).json({ error: 'Failed to save 2FA: ' + e.message });
        }
    }

    sessionData.needs_2fa = false;
    delete sessionData.temp_secret;
    VALID_SESSIONS.set(cToken, sessionData);

    res.json({ success: true });
});

// ─── User Management API ───────────────────────────────────────────────────────

// List all users
app.get('/api/admin/users', async (req, res) => {
    const pool = pools['domain-hub'];
    if (!pool) return res.status(500).json({ error: 'Database offline' });

    try {
        const { rows } = await pool.query(`
            SELECT id, username, is_active, 
                   (two_factor_secret IS NOT NULL) as has_2fa,
                   created_at, last_login
            FROM admin_users
            ORDER BY created_at ASC
        `);
        res.json({ users: rows, total: rows.length, max: MAX_USERS });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Create user
app.post('/api/admin/users/create', async (req, res) => {
    const { username, password } = req.body;
    if (!username?.trim() || !password?.trim()) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const pool = pools['domain-hub'];
    if (!pool) return res.status(500).json({ error: 'Database offline' });

    try {
        // Enforce seat limit
        const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM admin_users WHERE is_active = TRUE');
        const activeCount = parseInt(countRows[0].count);
        if (activeCount >= MAX_USERS) {
            return res.status(403).json({
                error: `Seat limit reached (${MAX_USERS} users max). Deactivate an existing account first.`
            });
        }

        await pool.query(
            'INSERT INTO admin_users (username, password) VALUES ($1, $2)',
            [username.trim(), password.trim()]
        );
        res.json({ success: true, message: 'User created. They can log in and will be prompted to set up 2FA.' });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: e.message });
    }
});

// Update user password
app.patch('/api/admin/users/:id/password', async (req, res) => {
    const { password } = req.body;
    if (!password?.trim()) return res.status(400).json({ error: 'Password required' });

    const pool = pools['domain-hub'];
    if (!pool) return res.status(500).json({ error: 'Database offline' });

    try {
        const { rowCount } = await pool.query(
            'UPDATE admin_users SET password = $1 WHERE id = $2',
            [password.trim(), req.params.id]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Toggle user active status
app.patch('/api/admin/users/:id/toggle', async (req, res) => {
    const pool = pools['domain-hub'];
    if (!pool) return res.status(500).json({ error: 'Database offline' });

    // Prevent deactivating self
    const { rows } = await pool.query('SELECT username FROM admin_users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (rows[0].username === req.session?.username) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    try {
        await pool.query(
            'UPDATE admin_users SET is_active = NOT is_active WHERE id = $1',
            [req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reset 2FA for a user
app.patch('/api/admin/users/:id/reset-2fa', async (req, res) => {
    const pool = pools['domain-hub'];
    if (!pool) return res.status(500).json({ error: 'Database offline' });

    try {
        await pool.query(
            'UPDATE admin_users SET two_factor_secret = NULL WHERE id = $1',
            [req.params.id]
        );
        res.json({ success: true, message: 'User will be prompted to set up 2FA on next login.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete user permanently
app.delete('/api/admin/users/:id', async (req, res) => {
    const pool = pools['domain-hub'];
    if (!pool) return res.status(500).json({ error: 'Database offline' });

    // Prevent deleting self
    const { rows } = await pool.query('SELECT username FROM admin_users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (rows[0].username === req.session?.username) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    try {
        await pool.query('DELETE FROM admin_users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Tracking Script ───────────────────────────────────────────────────────────
app.get('/api/track.js', (req, res) => {
    const siteId = req.query.site || 'unknown';
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;

    const script = `(function() {
        var _vx = { site: "${siteId}", host: "${protocol}://${host}" };
        function sendVerTrack(p) {
            var data = {
                site_label: _vx.site,
                referrer: document.referrer || '',
                screen_res: window.screen.width + 'x' + window.screen.height,
                language: navigator.language || '',
                path: p || window.location.pathname
            };
            fetch(_vx.host + '/api/track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).catch(function(){});
        }
        sendVerTrack();
        var _origPush = history.pushState;
        history.pushState = function() {
            _origPush.apply(history, arguments);
            setTimeout(function(){ sendVerTrack(location.pathname); }, 150);
        };
        window.addEventListener('popstate', function(){ sendVerTrack(location.pathname); });
    })();`;

    res.type('application/javascript').send(script);
});

// ─── Geo Lookup ────────────────────────────────────────────────────────────────
async function getGeo(ip) {
    try {
        if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) return {};
        const response = await fetch(
            `http://ip-api.com/json/${ip}?fields=status,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`,
            { signal: AbortSignal.timeout(3000) }
        );
        const geo = await response.json();
        return geo.status === 'success' ? geo : {};
    } catch (_) { return {}; }
}

// ─── Track Endpoint ────────────────────────────────────────────────────────────
app.post('/api/track', async (req, res) => {
    const { site_label, referrer, screen_res, language, path } = req.body;
    let ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    try {
        const geo = await getGeo(ip);
        const pool = pools['domain-hub'];
        if (!pool) return res.status(500).json({ error: 'DB offline' });

        const trueReferrer = path ? `${referrer || ''} [${path}]` : (referrer || '');

        await pool.query(`
            INSERT INTO visitor_logs (
                timestamp, site_label, ip, city, region, country, country_code,
                isp, lat, lon, timezone, user_agent, screen_res, referrer, language, zip, org
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        `, [
            new Date(), site_label || 'Default', ip,
            geo.city || '', geo.regionName || '', geo.country || '', geo.countryCode || '',
            geo.isp || '', parseFloat(geo.lat) || 0, parseFloat(geo.lon) || 0,
            geo.timezone || '', req.headers['user-agent'] || '',
            screen_res || '', trueReferrer, language || '', geo.zip || '', geo.org || ''
        ]);

        res.json({ success: true });
    } catch (e) {
        console.error('Track error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Logs API ──────────────────────────────────────────────────────────────────
app.get('/api/logs', async (req, res) => {
    const { site } = req.query;
    let siteConfig = SITE_MAP.find(s => s.id === site) || { id: site, db: 'domain-hub', filter: site };

    let rows = [];

    // Central hub logs
    try {
        const poolHub = pools['domain-hub'];
        if (poolHub) {
            const result = await poolHub.query(
                `SELECT timestamp, ip, city, region, country_code, user_agent, referrer,
                        lat, lon, isp, org, screen_res
                 FROM visitor_logs
                 WHERE site_label = $1
                 ORDER BY timestamp DESC LIMIT 150`,
                [siteConfig.filter || siteConfig.id]
            );
            rows = rows.concat(result.rows);
        }
    } catch (err) {
        console.error('Hub logs error:', err.message);
    }

    // Historical DB logs
    if (siteConfig.db && siteConfig.db !== 'domain-hub') {
        try {
            const specificPool = pools[siteConfig.db];
            if (specificPool) {
                let result;
                if (siteConfig.db === 'nexus-creative-tech') {
                    result = await specificPool.query(
                        `SELECT timestamp, query as ip, city, region_name as region,
                                country_code, user_agent, referrer, lat, lon
                         FROM analytics_events ORDER BY timestamp DESC LIMIT 150`
                    );
                } else if (siteConfig.db === 'spelling-bee') {
                    result = await specificPool.query(
                        `SELECT timestamp, ip, city, region, country as country_code,
                                user_agent, referrer, lat, lng as lon
                         FROM visitor_logs ORDER BY timestamp DESC LIMIT 150`
                    );
                } else if (siteConfig.db === 'link.veroe.space') {
                    result = await specificPool.query(
                        `SELECT timestamp, ip, city, region, country as country_code,
                                ua as user_agent, '' as referrer, 0 as lat, 0 as lon
                         FROM pixel_hits ORDER BY timestamp DESC LIMIT 150`
                    );
                } else if (siteConfig.db === 'farkle-staging') {
                    result = await specificPool.query(
                        `SELECT timestamp, ip, city, region, country_code,
                                user_agent, referrer, lat, lon
                         FROM visitor_logs ORDER BY timestamp DESC LIMIT 150`
                    ).catch(() => ({ rows: [] }));
                }
                if (result) rows = rows.concat(result.rows);
            }
        } catch (err) {
            console.error(`Historical logs error (${siteConfig.db}):`, err.message);
        }
    }

    rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (rows.length > 200) rows = rows.slice(0, 200);
    res.json(rows);
});

// ─── Sites API ─────────────────────────────────────────────────────────────────
app.get('/api/sites', async (req, res) => {
    const pool = pools['domain-hub'];
    const dynamicSites = [];

    if (pool) {
        try {
            const { rows } = await pool.query('SELECT DISTINCT site_label FROM visitor_logs ORDER BY site_label');
            rows.forEach(r => {
                const label = (r.site_label || '').trim();
                if (!label || label === 'Default') return;
                const isDup = SITE_MAP.some(s =>
                    [s.filter, s.id, s.label].some(v => v && v.toLowerCase() === label.toLowerCase())
                );
                if (!isDup) {
                    dynamicSites.push({ id: label, label, host: 'Auto-Discovered', db: 'domain-hub', filter: label });
                }
            });
        } catch (e) {
            console.error('Dynamic sites error:', e.message);
        }
    }

    res.json([...SITE_MAP, ...dynamicSites]);
});

// ─── Stats API ─────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
    await probeAllDatabases();
    const aggregated = getStats();

    const combined = dbConfigs.map(config => {
        const pStatus = poolStatus[config.name] || {};
        const aggr = aggregated[config.name] || {};
        return {
            name: config.name,
            ...pStatus,
            ...aggr,
            status: pStatus.status === 'online' ? (aggr.status || 'Online') : (pStatus.status || 'Unknown')
        };
    });

    res.json(combined);
});

// ─── DB Health API ─────────────────────────────────────────────────────────────
app.get('/api/db/health', async (req, res) => {
    await probeAllDatabases();
    res.json(poolStatus);
});

// ─── Static ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile('index.html', { root: __dirname }));

// ─── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`🚀 Analytics Central running on port ${PORT}`);
    await bootstrapSchema();
    await seedMasterAccount();
    await probeAllDatabases();
    await runAggregator();

    // Re-probe DBs every 5 minutes
    setInterval(probeAllDatabases, 5 * 60 * 1000);
});
