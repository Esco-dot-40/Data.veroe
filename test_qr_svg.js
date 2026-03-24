const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

async function test_svg() {
    try {
        const secret = speakeasy.generateSecret({ name: 'Veroix Analytics Central (test_user)' });
        secret.otpauth_url = `otpauth://totp/Veroix:test_user?secret=${secret.base32}&issuer=Veroix`;
        
        const qrSvg = await qrcode.toString(secret.otpauth_url, { type: 'svg' });
        console.log("SVG Length:", qrSvg.length);
        console.log("SVG Snippet:", qrSvg.substring(0, 100));

        const templatePath = path.join(__dirname, 'setup.html');
        let html = fs.readFileSync(templatePath, 'utf8');
        
        html = html.replace('{{QR_SVG}}', qrSvg)
                   .replace('{{SECRET_KEY}}', secret.base32);

        if (html.includes('{{QR_SVG}}')) {
             console.log("❌ SVG Replace failed!");
        } else {
             console.log("✅ SVG Replace successful!");
        }
        
        fs.writeFileSync('output-test.html', html);
        console.log("Wrote to output-test.html");
    } catch (e) {
        console.error("Test Error:", e);
    }
}

test_svg();
