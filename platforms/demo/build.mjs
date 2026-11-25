// Builds the demo site into docs/ (what GitHub Pages serves from the demo branch).
//   node platforms/demo/build.mjs
// Copies the shared app (core/), the demo platform script and the sample data. No dependencies.
import { cpSync, rmSync, copyFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'docs');
const core = path.join(root, 'core');
const demo = path.join(root, 'platforms', 'demo');

// Only files this script makes are replaced; anything else in docs/ (the architecture notes, design mockups) is left alone.
const PAGES = ['index.html', 'notes.html', 'app.js', 'notes.js', 'shell.js', 'status.js', 'theme-init.js'];
for (const f of [...PAGES, 'platform.js', 'sample-data.json', '.nojekyll']) rmSync(path.join(out, f), { force: true });
rmSync(path.join(out, 'design-system'), { recursive: true, force: true });

mkdirSync(out, { recursive: true });
for (const f of PAGES) copyFileSync(path.join(core, f), path.join(out, f));
cpSync(path.join(core, 'design-system'), path.join(out, 'design-system'), { recursive: true });
copyFileSync(path.join(demo, 'platform.js'), path.join(out, 'platform.js'));
copyFileSync(path.join(demo, 'sample-data.json'), path.join(out, 'sample-data.json'));
writeFileSync(path.join(out, '.nojekyll'), ''); // serve the files as they are; no Jekyll processing

for (const f of [...PAGES, 'platform.js', 'sample-data.json']) if (!existsSync(path.join(out, f))) throw new Error('missing ' + f);
console.log(`Built the demo site into ${path.relative(root, out)}/`);
