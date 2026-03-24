const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

async function test_svg() {
    try {
        const secret = speakeasy.generateSecret({ name: 'Veroix Analytics Central (test_user)' });
        secret.otpauth_url = `otpauth://totp/Veroix:test_user?secret=${secret.base32}&issuer=Veroix`;
        
        // Generate SVG string just like index.js
        const qrSvg = await qrcode.toString(secret.otpauth_url, { type: 'svg' });
        console.log("SVG Length:", qrSvg.length);

        const templatePath = path.join(__dirname, 'setup.html');
        let html = fs.readFileSync(templatePath, 'utf8');
        
        // Replace correct token {{QR_SVG}} instead of {{QR_IMG}}
        html = html.replace('{{QR_SVG}}', qrSvg)
                   .replace('{{SECRET_KEY}}', secret.base32);

        if (html.includes('{{QR_SVG}}')) {
             console.log("❌ SVG Replace failed!");
        } else {
             console.log("✅ SVG Replace successful!");
        }
        
        fs.writeFileSync('output-test.html', html);
        console.log("Wrote fully rendered page to output-test.html for debugging.");
    } catch (e) {
        console.error("Test Error:", e);
    }
}

test_svg();
