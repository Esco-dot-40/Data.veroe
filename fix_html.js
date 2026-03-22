const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');
code = code.replace(/\\`/g, '`');
code = code.replace(/\\\$\{/g, '${');
fs.writeFileSync('index.html', code);
