// Rasterize the original cat + block SVG for iOS, PWA and favicon.
// Usage: npm run icons [-- --out <dir> --master <file.png>]
// Requires npm install and an installed Chrome/Chromium (or CHROME_PATH).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const outDir = path.resolve(opt('--out') || path.join(project, 'icons'));
const svg = await fs.readFile(path.join(project, 'icons/icon.svg'), 'utf8');
const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const files = [
  ['apple-touch-icon.png', 180, 1], ['favicon-32.png', 32, 1],
  ['icon-192.png', 192, 1], ['icon-512.png', 512, 1], ['icon-maskable-512.png', 512, .86],
];
if (opt('--master')) files.push([path.resolve(opt('--master')), 1024, 1]);
await fs.mkdir(outDir, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, scale] of files) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:#93AEFC}body{display:grid;place-items:center}img{width:${size * scale}px;height:${size * scale}px}</style><img src="${url}">`);
    await page.locator('img').evaluate((img) => img.decode());
    const file = path.isAbsolute(name) ? name : path.join(outDir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    console.log(`make-icons: ${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
