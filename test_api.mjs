
// No import needed for Node 18+

const url = 'http://localhost:3000/api/stats';
const auth = Buffer.from('admin:veroe-admin-2026').toString('base64');

async function test() {
    try {
        const res = await fetch(url, {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(e);
    }
}

test();
