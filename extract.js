const fs = require('fs');
const raw = fs.readFileSync('index.js', 'utf8');

const startIdx = raw.indexOf(`app.get('/',`);
const bodyIdx = raw.indexOf('res.send(`', startIdx);
const endIdx = raw.lastIndexOf(`\`);\n});`);

if (startIdx !== -1 && bodyIdx !== -1 && endIdx !== -1) {
    const html = raw.substring(bodyIdx + 11, endIdx);
    fs.writeFileSync('index.html', html.trim());
    
    const newCode = raw.substring(0, startIdx) + 
      "app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));\n\n" + 
      raw.substring(endIdx + 6);
      
    fs.writeFileSync('index.js', newCode);
    console.log("Extraction successful!");
} else {
    console.log("No match found.");
}
