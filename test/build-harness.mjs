// Regenerates test/harness.html from the real popup.html, so the browser
// harness can never drift from the extension. Run after editing popup.html:
//   node test/build-harness.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'popup.html'), 'utf8');

const out = src
  .replace('<link rel="stylesheet" href="popup.css">',
    '<link rel="stylesheet" href="../popup.css">')
  .replace('<script type="module" src="popup.js"></script>',
    '<script type="module" src="./mocks.js"></script>\n'
    + '  <script type="module" src="../popup.js"></script>\n'
    + '  <script type="module" src="./scenario.js"></script>');

if (!out.includes('../popup.js') || !out.includes('../popup.css')) {
  throw new Error('popup.html no longer matches the expected script/style tags');
}
writeFileSync(path.join(here, 'harness.html'), out);
console.log('harness.html regenerated from popup.html');
