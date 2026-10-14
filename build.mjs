// Build Hearth into ./dist (static files for GitHub Pages).
//   node build.mjs           -> production build
//   node build.mjs --serve   -> build, then serve dist/ on http://localhost:8080
import * as esbuild from 'esbuild';
import { cp, rm, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, extname, relative } from 'node:path';

const out = 'dist';
const serve = process.argv.includes('--serve');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await esbuild.build({
  entryPoints: { app: 'src/main.js', 'webllm-worker': 'src/webllm-worker.js' },
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  outdir: out,
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
  legalComments: 'none',
  // node-only branches inside libraries
  external: ['fs', 'path', 'url', 'crypto', 'module', 'worker_threads', 'perf_hooks'],
  define: { 'process.env.NODE_ENV': '"production"' },
});

await cp('public', out, { recursive: true });
await cp('node_modules/@wllama/wllama/esm/wasm/wllama.wasm', join(out, 'wllama.wasm'));
await cp('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', join(out, 'pdf.worker.min.mjs'));
await writeFile(join(out, '.nojekyll'), '');

// service worker: version + precache list
async function walk(dir) {
  const files = [];
  for (const f of await readdir(dir)) {
    const p = join(dir, f);
    if ((await stat(p)).isDirectory()) files.push(...await walk(p)); else files.push(p);
  }
  return files;
}
const all = (await walk(out)).map((p) => relative(out, p).split('\\').join('/'));
const precache = ['./', ...all.filter((f) => !f.startsWith('cmaps/') && !['sw.js', '.nojekyll'].includes(f))];
const version = Date.now().toString(36);
let sw = await readFile(join(out, 'sw.js'), 'utf8');
sw = sw.replace("'__VERSION__'", JSON.stringify(version)).replace('__PRECACHE__', JSON.stringify(precache));
await writeFile(join(out, 'sw.js'), sw);

let total = 0;
for (const f of all) total += (await stat(join(out, f))).size;
console.log(`\nBuilt ${all.length} files, ${(total / 1048576).toFixed(1)} MB, version ${version}`);

if (serve) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.bcmap': 'application/octet-stream' };
  createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    try {
      const body = await readFile(join(out, p));
      res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  }).listen(8080, () => console.log('Serving dist/ at http://localhost:8080'));
}
