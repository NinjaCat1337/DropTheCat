// Local static server for playing on this PC and on the iPhone over Wi-Fi. Zero dependencies.
// Usage: npm start   (node tools/serve.mjs [--port 8080] [--root <dir>]; the PORT env var works too)
// - binds 0.0.0.0; if the port is busy it takes the next free one;
// - Cache-Control: no-cache (always revalidated via ETag), correct MIME types (.webmanifest, .woff2, .mjs…);
// - like GitHub Pages: a folder URL without "/" is redirected, and paths are CASE-SENSITIVE
//   (Windows is not, so a wrong-case import is reported here instead of failing only after deploy).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
};
const DEFAULT_PORT = 8080;
const MAX_TRIES = 20;

function parseArgs() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const port = Number(opt('--port') || process.env.PORT || DEFAULT_PORT);
  return {
    root: path.resolve(opt('--root') || path.join(here, '..')),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
  };
}

/** Exact-case path check (GitHub Pages is case-sensitive, NTFS is not). Returns the on-disk spelling. */
function diskSpelling(root, rel) {
  let dir = root;
  const out = [];
  for (const part of rel.split('/').filter(Boolean)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const hit = names.find((n) => n === part) || names.find((n) => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    out.push(hit);
    dir = path.join(dir, hit);
  }
  return out.join('/');
}

function send(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', ...headers });
  res.end(text);
}

function createHandler(root) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      send(res, 400, 'Bad Request\n');
      return;
    }
    const file = path.resolve(root, '.' + pathname);
    if (pathname.includes('\0') || (file !== root && !file.startsWith(root + path.sep))) {
      send(res, 403, 'Forbidden\n');
      return;
    }
    const rel = path.relative(root, file).split(path.sep).join('/');
    const spelled = rel ? diskSpelling(root, rel) : '';
    if (spelled === null) {
      console.log(`404 ${pathname}`);
      send(res, 404, 'Not Found\n');
      return;
    }
    if (spelled !== rel) {
      console.log(`404 ${pathname}  ← letter case differs from the file on disk: /${spelled} (GitHub Pages would 404 too)`);
      send(res, 404, `Not Found: letter case differs from the file on disk (/${spelled})\n`);
      return;
    }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        if (!pathname.endsWith('/')) {
          res.writeHead(301, { Location: url.pathname + '/' + url.search, 'Cache-Control': 'no-cache' });
          res.end();
          return;
        }
        serveFile(req, res, path.join(file, 'index.html'), pathname);
        return;
      }
      if (err || !st.isFile()) {
        console.log(`404 ${pathname}`);
        send(res, 404, 'Not Found\n');
        return;
      }
      serveFile(req, res, file, pathname, st);
    });
  };
}

function serveFile(req, res, file, pathname, known) {
  let st = known;
  try {
    st = st || fs.statSync(file);
  } catch {
    console.log(`404 ${pathname}`);
    send(res, 404, 'Not Found\n');
    return;
  }
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Non-internal IPv4 addresses (link-local 169.254.* skipped), private LAN ranges first. */
function lanAddresses() {
  const list = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (v4 && !info.internal && !info.address.startsWith('169.254.')) list.push({ name, address: info.address });
    }
  }
  const rank = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2);
  return list.sort((a, b) => rank(a.address) - rank(b.address));
}

function listen(server, port, triesLeft) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && triesLeft > 1) resolve(listen(server, port + 1, triesLeft - 1));
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function main() {
  const { root, port: wanted } = parseArgs();
  if (!fs.existsSync(root)) {
    console.error(`Directory not found: ${root}`);
    process.exitCode = 1;
    return;
  }
  const server = http.createServer(createHandler(root));
  let port;
  try {
    port = await listen(server, wanted, MAX_TRIES);
  } catch (err) {
    console.error(`Could not start server: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const lan = lanAddresses();
  console.log('');
  console.log('Meow Drop — local server');
  console.log(`  Directory:    ${root}`);
  if (port !== wanted) console.log(`  (port ${wanted} is busy, using ${port})`);
  console.log(`  On this PC:   http://localhost:${port}/`);
  for (const { name, address } of lan) console.log(`  On Wi-Fi:     http://${address}:${port}/   (${name})`);
  if (!lan.length) console.log('  On Wi-Fi:     no address found; connect to Wi-Fi and check ipconfig');
  console.log('');
  console.log('On an iPhone connected to the same Wi-Fi, open the network address in Safari.');
  console.log('Offline mode requires HTTPS or localhost. Use GitHub Pages for offline installation.');
  console.log('Stop the server: Ctrl+C');
  console.log('');
}

main();
