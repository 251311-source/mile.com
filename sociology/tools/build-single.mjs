// sociology/ 폴더를 HTML 파일 하나로 묶는다 (CSS·JS 인라인).
import { build } from 'esbuild';
import fs from 'node:fs';
const ROOT = new URL('../', import.meta.url).pathname;
const out = process.argv[2] || 'sociology-study.html';
const res = await build({ entryPoints: [ROOT + 'js/app.js'], bundle: true, format: 'esm', write: false, logLevel: 'error', charset: 'utf8' });
let js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(ROOT + 'css/style.css', 'utf8');
let html = fs.readFileSync(ROOT + 'index.html', 'utf8');
html = html.replace('<link rel="stylesheet" href="css/style.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script type="module" src="js/app.js"></script>', () => `<script type="module">\n${js}\n</script>`);
fs.writeFileSync(out, html);
console.log(out, (html.length / 1024).toFixed(0) + 'KB');
