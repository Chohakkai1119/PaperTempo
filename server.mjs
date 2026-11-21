import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const localConverter = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf2music', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pdf2music.exe' : 'pdf2music');
const converter = process.env.PDF2MUSIC_BIN || (existsSync(localConverter) ? localConverter : 'pdf2music');
const port = Number(process.env.PORT || 8000);
const maxPdfBytes = 20 * 1024 * 1024;
const maxRequestBytes = maxPdfBytes + 64 * 1024;

function send(response, status, data, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
  response.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function readRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) throw Object.assign(new Error('PDF must be 20 MB or smaller.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function getUploadedPdf(request, body) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(request.headers['content-type'] || '')?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw Object.assign(new Error('The upload request is missing its multipart boundary.'), { status: 400 });
  const marker = Buffer.from(`--${boundary}`);
  let cursor = 0;
  while ((cursor = body.indexOf(marker, cursor)) !== -1) {
    const headerStart = cursor + marker.length + 2;
    if (body.subarray(cursor + marker.length, cursor + marker.length + 2).toString() === '--') break;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;
    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const disposition = /content-disposition:\s*form-data;[^\r\n]*name="file"[^\r\n]*filename="([^"]*)"/i.exec(headers);
    const dataStart = headerEnd + 4;
    const next = body.indexOf(marker, dataStart);
    if (next === -1) break;
    if (disposition) return { name: path.basename(disposition[1]), data: body.subarray(dataStart, next - 2) };
    cursor = next;
  }
  throw Object.assign(new Error('Choose a PDF file to convert.'), { status: 400 });
}

async function convert(request, response) {
  let temporary;
  try {
    const body = await readRequest(request);
    const file = getUploadedPdf(request, body);
    if (!file.name.toLowerCase().endsWith('.pdf')) throw Object.assign(new Error('Choose a PDF file.'), { status: 400 });
    if (!file.data.length || file.data.length > maxPdfBytes) throw Object.assign(new Error('PDF must be between 1 byte and 20 MB.'), { status: 413 });
    if (file.data.subarray(0, 5).toString() !== '%PDF-') throw Object.assign(new Error('This file does not look like a valid PDF.'), { status: 400 });

    temporary = await mkdtemp(path.join(tmpdir(), 'papertempo-'));
    const input = path.join(temporary, 'score.pdf');
    const output = path.join(temporary, 'output');
    await mkdir(output);
    await writeFile(input, file.data, { flag: 'wx' });
    try {
      await execFileAsync(converter, [input, '--output', output, '--format', 'musicxml'], {
        timeout: 600_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('The server cannot find pdf2music. Install the OMR converter and follow the README setup steps.');
      if (error.killed) throw new Error('PDF conversion took too long. Try a shorter or clearer score.');
      throw new Error('The PDF could not be converted. Try a clearer, printed score PDF.');
    }
    const outputs = (await readdir(output)).filter((name) => name.toLowerCase().endsWith('.musicxml'));
    if (!outputs.length) throw new Error('The converter did not produce a MusicXML file.');
    const musicxml = await readFile(path.join(output, outputs[0]), 'utf8');
    if (musicxml.length > 8 * 1024 * 1024) throw new Error('The converted score is too large to open.');
    send(response, 200, { musicxml });
  } catch (error) {
    send(response, error.status || 422, { error: error.message || 'PDF conversion failed.' });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.musicxml': 'application/vnd.recordare.musicxml+xml; charset=utf-8', '.woff2': 'font/woff2',
};

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/api/convert') return void await convert(request, response);
  if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { error: 'Method not allowed.' });
  let filename;
  try { filename = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch { return send(response, 400, { error: 'Invalid URL.' }); }
  const target = path.resolve(root, `.${filename}`);
  if (!target.startsWith(root + path.sep)) return send(response, 404, { error: 'Not found.' });
  try {
    const contents = await readFile(target);
    response.writeHead(200, {
      'content-type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch {
    send(response, 404, { error: 'Not found.' });
  }
}).listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`PaperTempo server listening on http://${process.env.HOST || '127.0.0.1'}:${port}`);
});
