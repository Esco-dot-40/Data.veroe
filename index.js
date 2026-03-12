const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const basicAuth = require('express-basic-auth');
const helmet = require('helmet');
const cors = require('cors');
const { runAggregator, getStats } = require('./aggregator');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const adminUser = (process.env.ADMIN_USER || 'admin').replace(/['"]/g, '').trim();
const adminPass = (process.env.ADMIN_PASS || 'password').replace(/['"]/g, '').trim();

const users = {};
users[adminUser] = adminPass;

console.log(`[Auth] Configuring access for user: "${adminUser}"`);

app.use(basicAuth({
    users,
    challenge: true,
    realm: 'Veroix Analytics Central'
}));


const dbConfigs = [
    { name: 'domain-hub', envKey: 'DB_DOMAIN_HUB_URL' },
    { name: 'farkle-staging', envKey: 'DB_FARKLE_STAGING_URL' },
    { name: 'link.veroe.space', envKey: 'DB_LINK_VEROE_SPACE_URL' },
    { name: 'nexus-creative-tech', envKey: 'DB_NEXUS_CREATIVE_URL' },
    { name: 'spelling-bee', envKey: 'DB_SPELLING_BEE_URL' }
];

const pools = {};
dbConfigs.forEach(config => {
    const connectionString = process.env[config.envKey];
    if (connectionString) {
        pools[config.name] = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    }
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
    const combined = health.map(h => ({
        ...h,
        ...aggregated[h.name]
    }));

    res.json(combined);
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Veroe Central Analytics</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #030305;
            --card-bg: rgba(20, 20, 25, 0.7);
            --primary: #00f5ff;
            --secondary: #7000ff;
            --success: #00ff88;
            --error: #ff3e3e;
            --text: #e1e1e6;
            --text-dim: #a1a1aa;
        }

        * { box-sizing: border-box; }
        body {
            background: var(--bg);
            color: var(--text);
            font-family: 'Inter', sans-serif;
            margin: 0;
            padding: 0;
            min-height: 100vh;
            background: radial-gradient(circle at top right, #1a1a2e, #030305);
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .header {
            width: 100%;
            padding: 2rem;
            text-align: center;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            background: rgba(10, 10, 15, 0.5);
            backdrop-filter: blur(10px);
            margin-bottom: 2rem;
        }

        h1 {
            font-family: 'Orbitron', sans-serif;
            font-size: 2.5rem;
            letter-spacing: 4px;
            margin: 0;
            background: linear-gradient(90deg, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 0 0 20px rgba(0, 245, 255, 0.3);
        }

        .container {
            width: 95%;
            max-width: 1200px;
            padding-bottom: 4rem;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 1.5rem;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 1.5rem;
            padding: 1.5rem;
            backdrop-filter: blur(12px);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            position: relative;
            overflow: hidden;
        }

        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 20px rgba(0, 245, 255, 0.1);
            border-color: rgba(0, 245, 255, 0.3);
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
        }

        .db-name {
            font-family: 'Orbitron', sans-serif;
            font-size: 1.1rem;
            color: var(--primary);
        }

        .status-badge {
            font-size: 0.75rem;
            font-weight: bold;
            padding: 0.4rem 0.8rem;
            border-radius: 2rem;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .status-online { background: rgba(0, 255, 136, 0.1); color: var(--success); border: 1px solid rgba(0, 255, 136, 0.2); }
        .status-offline { background: rgba(255, 62, 62, 0.1); color: var(--error); border: 1px solid rgba(255, 62, 62, 0.2); }

        .metrics {
            display: grid;
            grid-template-columns: 1fr 1.5fr;
            gap: 1rem;
        }

        .metric {
            background: rgba(255, 255, 255, 0.03);
            padding: 1rem;
            border-radius: 1rem;
            display: flex;
            flex-direction: column;
        }

        .metric-label {
            font-size: 0.7rem;
            color: var(--text-dim);
            text-transform: uppercase;
            margin-bottom: 0.5rem;
        }

        .metric-value {
            font-size: 1.4rem;
            font-weight: 600;
        }

        .latency { font-size: 0.8rem; color: var(--text-dim); margin-top: 0.2rem; }

        .last-visit {
            grid-column: 1 / -1;
            margin-top: 0.5rem;
            font-size: 0.8rem;
            color: var(--text-dim);
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            padding-top: 1rem;
        }

        .refresh-bar {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            background: var(--primary);
            color: #000;
            padding: 0.5rem 1rem;
            border-radius: 2rem;
            font-weight: bold;
            font-size: 0.8rem;
            box-shadow: 0 4px 15px rgba(0, 245, 255, 0.4);
            cursor: pointer;
        }

        .global-summary {
            width: 100%;
            display: flex;
            justify-content: center;
            gap: 2rem;
            margin-bottom: 3rem;
        }

        .summary-item {
            text-align: center;
        }

        .summary-value {
            font-family: 'Orbitron', sans-serif;
            font-size: 2.4rem;
            color: var(--text);
            display: block;
        }

        .summary-label {
            color: var(--primary);
            text-transform: uppercase;
            font-size: 0.8rem;
            letter-spacing: 2px;
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }

        .pulse { animation: pulse 2s infinite ease-in-out; }
    </style>
</head>
<body>
    <div class="header">
        <h1>VEROIX ANALYTICS CENTRAL</h1>
    </div>

    <div class="container">
        <div class="global-summary">
            <div class="summary-item">
                <span class="summary-value" id="global-total">-</span>
                <span class="summary-label">Total Reach</span>
            </div>
            <div class="summary-item">
                <span class="summary-value" id="global-blocked">-</span>
                <span class="summary-label">Shielded Hits</span>
            </div>
            <div class="summary-item">
                <span class="summary-value" id="global-active">-</span>
                <span class="summary-label">Active Nodes</span>
            </div>
        </div>

        <div class="stats-grid" id="stats-grid">
            <!-- Cards will be injected here -->
        </div>
    </div>

    <div class="refresh-bar" id="refresh-indicator">AUTO-SYNC ACTIVE</div>

    <script>
        async function fetchData() {
            try {
                const res = await fetch("/api/stats");
                const data = await res.json();
                renderCards(data);
                updateSummary(data);
            } catch (e) {
                console.error("Fetch error:", e);
            }
        }

        function updateSummary(data) {
            const total = data.reduce((acc, curr) => acc + (curr.totalVisits || 0), 0);
            const blocked = data.reduce((acc, curr) => acc + (curr.blockedVisits || 0), 0);
            const active = data.filter(d => d.status === "Online").length;

            document.getElementById("global-total").textContent = total.toLocaleString();
            document.getElementById("global-blocked").textContent = blocked.toLocaleString();
            document.getElementById("global-active").textContent = active + "/" + data.length;
        }

        function renderCards(data) {
            const grid = document.getElementById("stats-grid");
            grid.innerHTML = data.map(db => {
                const lastSeen = db.lastVisit ? new Date(db.lastVisit).toLocaleString() : 'Never';
                return \`
                    <div class="card">
                        <div class="card-header">
                            <span class="db-name">\${db.name}</span>
                            <span class="status-badge \${db.status === 'Online' ? 'status-online' : 'status-offline'}">\${db.status}</span>
                        </div>
                        <div class="metrics">
                            <div class="metric">
                                <span class="metric-label">Total Traffic</span>
                                <span class="metric-value">\${(db.totalVisits || 0).toLocaleString()}</span>
                            </div>
                            <div class="metric">
                                <span class="metric-label">Blocked Attempts</span>
                                <span class="metric-value" style="color: \${db.blockedVisits > 0 ? 'var(--error)' : 'inherit'}">\${(db.blockedVisits || 0).toLocaleString()}</span>
                            </div>
                            <div class="metric">
                                <span class="metric-label">Latency</span>
                                <span class="metric-value" style="font-size: 1rem; color: var(--primary)">\${db.latency || 'N/A'}</span>
                            </div>
                        </div>
                        <div class="last-visit">
                            Last meaningful activity: <span style="color: var(--text)">\${lastSeen}</span>
                        </div>
                    </div>
                \`;
            }).join("");
        }

        fetchData();
        setInterval(fetchData, 10000);
    </script>
</body>
</html>
    `);
});

app.listen(PORT, async () => {
    console.log('🚀 Analytics Central running on port ' + PORT);
    await runAggregator(); 
});

