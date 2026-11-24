// Decodes the base64 icon files in build/ into real icon files.
// The .png/.ico binaries cannot be stored in git through the text-only
// push flow, so the repo stores them as .b64 text and this script
// regenerates them. Runs automatically before every build (see the
// build scripts in package.json) and is safe to run by hand.
const fs = require('fs');
const path = require('path');

for (const name of ['icon.png', 'icon.ico']) {
  const src = path.join(__dirname, '..', 'build', name + '.b64');
  const dst = path.join(__dirname, '..', 'build', name);
  const data = Buffer.from(fs.readFileSync(src, 'utf8').trim(), 'base64');
  fs.writeFileSync(dst, data);
  console.log('Prepared ' + dst + ' (' + data.length + ' bytes)');
}
