// Removes the previous build output so every build produces one
// installer with the same name, overwriting the last one.
const fs = require('fs');
const path = require('path');
const dist = path.join(__dirname, '..', 'dist');
fs.rmSync(dist, { recursive: true, force: true });
console.log('Cleaned dist/');
