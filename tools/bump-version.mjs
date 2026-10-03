// Gives the site a new version tag, so browsers fetch fresh copies of every
// CSS/JS file instead of mixing old cached ones with a new page.
// Run after changing anything in css/ or js/:   node tools/bump-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
const current = read('js/app.js').match(/const APP_VERSION = '([^']+)'/)[1];

const d = new Date();
const pad = n => String(n).padStart(2, '0');
const next = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

for (const file of ['index.html', 'js/app.js']) {
  const text = read(file);
  if (!text.includes(current)) throw new Error(`${file} does not contain version ${current}`);
  writeFileSync(new URL(file, root), text.replaceAll(current, next));
}
console.log(`version ${current} -> ${next}`);
