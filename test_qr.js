const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const fs = require('fs');

async function test() {
    try {
        const secret = speakeasy.generateSecret({ name: 'Test' });
        const qr = await qrcode.toDataURL(secret.otpauth_url);
        console.log("QR Length:", qr.length);
        console.log("Starts with:", qr.substring(0, 30));
        
        let html = fs.readFileSync('setup.html', 'utf8');
        html = html.replace('{{QR_IMG}}', qr).replace('{{SECRET_KEY}}', secret.base32);
        
        if (html.includes('{{QR_IMG}}')) {
            console.log("❌ Replace failed!");
        } else {
            console.log("✅ Replace successful!");
        }
    } catch (e) { console.error(e); }
}

test();
