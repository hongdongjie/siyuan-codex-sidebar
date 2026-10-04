'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'siyuan-codex-sidebar');
fs.mkdirSync(out, { recursive: true });
const client = fs.readFileSync(path.join(root, 'src/client.cjs'), 'utf8');
const plugin = fs.readFileSync(path.join(root, 'src/index.cjs'), 'utf8').replace("require('./client.cjs')", '__client');
fs.writeFileSync(path.join(out, 'index.js'), `const __client = (() => { const module = {exports:{}};\n${client}\nreturn module.exports; })();\n${plugin}`);
for (const [source, target] of [['src/index.css', 'index.css'], ['plugin.json','plugin.json'], ['README.md','README.md'], ['LICENSE-lucide.txt','LICENSE-lucide.txt'], ['LICENSE','LICENSE'], ['icon.png','icon.png']])
  fs.copyFileSync(path.join(root, source), path.join(out, target));
console.log(out);
