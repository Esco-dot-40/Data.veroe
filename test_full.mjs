// Native fetch
import fs from 'fs';

const url = 'http://localhost:3000/';
const auth = Buffer.from('admin:veroe-admin-2026').toString('base64');

async function test() {
    try {
        const res = await fetch(url, {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });
        const html = await res.text();
        fs.writeFileSync('index_output.html', html);
        console.log("Root HTML fetched and saved to index_output.html");
        
        const apiRes = await fetch('http://localhost:3000/api/stats', {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });
        const stats = await apiRes.json();
        console.log("API Stats:");
        console.log(JSON.stringify(stats, null, 2));
    } catch (e) {
        console.error(e);
    }
}

test();
