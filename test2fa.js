// Using native fetch
const speakeasy = require('speakeasy');

async function test_flow() {
    try {
        const { Pool } = require('pg');
        const pool = new Pool({
            connectionString: process.env.DB_DOMAIN_HUB_URL
        });

        console.log("1. Creating test user directly in DB...");
        // Delete previous if exists to start fresh
        await pool.query('DELETE FROM admin_users WHERE username = $1', ['test_admin_2fa']);
        await pool.query('INSERT INTO admin_users (username, password) VALUES ($1, $2)', ['test_admin_2fa', 'test_password']);
        console.log("Created test user 'test_admin_2fa' in DB.");
        await pool.end();

        console.log("\n2. Logging in as test user (First time)...");
        const loginTestRes = await fetch('http://localhost:3000/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: 'test_admin_2fa', pass: 'test_password', token: '000000' })
        });

        if (!loginTestRes.ok) {
            console.error("Login test user failed:", await loginTestRes.text());
            return;
        }

        const testCookies = loginTestRes.headers.get('set-cookie');
        const loginData = await loginTestRes.json();
        console.log("Logged in as test user. Redirect:", loginData.redirect);

        if (loginData.redirect !== '/setup-2fa') {
            console.error("Unexpected redirect:", loginData.redirect);
            return;
        }

        console.log("\n3. Accessing /setup-2fa to generate secret...");
        const setupRes = await fetch('http://localhost:3000/setup-2fa', {
            headers: { 'Cookie': testCookies }
        });

        if (!setupRes.ok) {
            console.error("Setup page access failed:", await setupRes.text());
            return;
        }

        const html = await setupRes.text();
        console.log("Setup page loaded.");

        // Print around QR_SVG
        const qrBlock = html.match(/<div class="qr-wrapper">([\s\S]*?)<\/div>\s*<\/div>/);
        if (qrBlock) {
             console.log("Rendered QR Block:\n", qrBlock[0]);
        } else {
             console.log("QR Block not found in HTML!");
        }

        // Extract secret
        const secretMatch = html.match(/id="secret">([^<]+)<\/div>/);
        if (!secretMatch) {
            console.error("Failed to extract secret key from HTML!");
            return;
        }

        const secretKey = secretMatch[1].trim();
        console.log("Extracted Secret:", secretKey);

        console.log("\n4. Generating 2FA code from secret...");
        const token = speakeasy.totp({
            secret: secretKey,
            encoding: 'base32'
        });
        console.log("Generated Token:", token);

        console.log("\n5. Logging in with 2FA token...");
        const finalLoginRes = await fetch('http://localhost:3000/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: 'test_admin_2fa', pass: 'test_password', token: token })
        });

        if (finalLoginRes.ok) {
             const finalData = await finalLoginRes.json();
             console.log("✅ 2FA Login SUCCESSFUL! Redirecting to:", finalData.redirect);
        } else {
             console.error("❌ 2FA Login FAILED!", await finalLoginRes.text());
        }

    } catch (e) { console.error("Flow Error:", e); }
}

test_flow();
