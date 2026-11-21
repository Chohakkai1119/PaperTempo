// Small helpers for Web-standard (Request/Response) function handlers.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** Reads and parses a JSON body, refusing anything larger than maxBytes. */
export async function readJsonBody(request, maxBytes) {
  const type = request.headers.get('content-type') ?? '';
  if (!/\bapplication\/json\b/i.test(type)) throw new HttpError(415, 'Send the request as application/json.');

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, `The request body must be at most ${maxBytes} bytes.`);
  if (!request.body) throw new HttpError(400, 'The request body is empty.');

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, `The request body must be at most ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  if (!text.trim()) throw new HttpError(400, 'The request body is empty.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}
