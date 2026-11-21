#!/usr/bin/env node
// Local dev server: serves dist/ and routes /api/<name> to api/<name>.js, like Vercel does.
//   npm run dev        → http://localhost:3000
// Reads an optional .env in the repo root. Without one, /api/drill uses the fallback drill.
// Uses localhost so the microphone works (browsers require localhost or HTTPS).

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const apiDir = join(root, 'api');
const port = Number(process.env.PORT) || 3000;

loadDotEnv(join(root, '.env'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.mxl': 'application/vnd.recordare.musicxml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

async function handleApi(req, res, url) {
  const name = url.pathname.slice('/api/'.length).replace(/\/$/, '');
  const file = join(apiDir, `${name}.js`);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) return send(res, 404, 'application/json', '{"error":"Not found"}');
  const mod = await import(pathToFileURL(file).href);
  const handler = mod[req.method];
  if (typeof handler !== 'function') return send(res, 405, 'application/json', '{"error":"Method not allowed"}');

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
  headers.set('x-real-ip', req.socket.remoteAddress ?? 'unknown');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const request = new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function handleStatic(res, url) {
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }
  let file = resolve(distDir, `.${path}`);
  if (file !== distDir && !file.startsWith(distDir + sep)) return send(res, 403, 'text/plain', 'Forbidden');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    send(res, 200, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', body);
  } catch {
    send(res, 404, 'text/plain', 'Not found');
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, 'application/json', '{"error":"Internal error"}');
    else res.end();
  }
  console.log(`${req.method} ${url.pathname} → ${res.statusCode}`);
});

server.listen(port, '127.0.0.1', () => {
  const cortex = process.env.SNOWFLAKE_ACCOUNT && process.env.SNOWFLAKE_PAT && process.env.SNOWFLAKE_MODEL;
  console.log(`PaperTempo dev server: http://localhost:${port}`);
  console.log(`Drill coach: ${cortex ? 'Snowflake Cortex (from env)' : 'fallback drills (no Snowflake env vars set)'}`);
});
