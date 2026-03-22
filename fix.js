const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

code = code.replace(/\\`/g, '`');
code = code.replace(/\\\$\{/g, '${');

fs.writeFileSync('index.js', code);
