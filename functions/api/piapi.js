/**
 * Cloudflare Pages Functions adapter.
 *
 * REQUIREMENT: enable the `nodejs_compat_v2` compatibility flag in your
 * Pages project settings (Settings → Functions → Compatibility flags).
 * Without it, `formidable`, `undici`, `socks-proxy-agent`, `https`, `net`,
 * `tls`, and `fs` will not work.
 *
 * Limitations on Workers runtime:
 *   - `formidable` is bypassed: multipart bodies are pre-parsed with the
 *     native `Request.formData()` Web API (see `preparseMultipart` below).
 *   - `undici` / `https.request` / `socks-proxy-agent` all fail on Workers,
 *     so proxied HTTP requests are routed through our custom `cfFetch`
 *     client from `../lib/cf-http.js`, which speaks SOCKS5 and HTTP CONNECT
 *     directly on top of `cloudflare:sockets`.
 *
 * Route: functions/api/piapi.js → handles /api/piapi for GET + POST.
 */

import { Readable } from 'node:stream';
import piapiHandler from '../../api/piapi.js';
import { cfFetch, parseProxyUrl } from '../lib/cf-http.js';

function makeReq(request, url, { skipBody = false } = {}) {
  const headers = {};
  for (const [k, v] of request.headers.entries()) headers[k.toLowerCase()] = v;

  const query = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  let stream;
  if (!skipBody && request.body) {
    const reader = request.body.getReader();
    stream = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) this.push(null);
          else this.push(Buffer.from(value));
        } catch (err) {
          this.destroy(err);
        }
      },
    });
  } else {
    // Either the body was consumed upstream (e.g. by request.formData()) or
    // there is no body. Provide an empty readable so `req.on('data'|'end')`
    // still resolves if anything tries to read it.
    stream = Readable.from([Buffer.alloc(0)]);
  }

  Object.assign(stream, {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    query,
  });
  return stream;
}

function makeRes() {
  let statusCode = 200;
  const headers = new Headers();
  const chunks = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    resolveDone();
  }

  return {
    res: {
      status(code) { statusCode = code; return this; },
      setHeader(name, value) { headers.set(name, String(value)); return this; },
      getHeader(name) { return headers.get(name); },
      json(payload) {
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
        chunks.push(new TextEncoder().encode(JSON.stringify(payload)));
        finish();
        return this;
      },
      send(payload) {
        if (payload instanceof Uint8Array) chunks.push(payload);
        else if (typeof payload === 'string') chunks.push(new TextEncoder().encode(payload));
        else if (payload != null) {
          if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
          chunks.push(new TextEncoder().encode(JSON.stringify(payload)));
        }
        finish();
        return this;
      },
      end(payload) {
        if (payload) {
          if (payload instanceof Uint8Array) chunks.push(payload);
          else chunks.push(new TextEncoder().encode(String(payload)));
        }
        finish();
        return this;
      },
      get headersSent() { return finished; },
    },
    toResponse: async () => {
      await done;
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { body.set(c, off); off += c.byteLength; }
      return new Response(body, { status: statusCode, headers });
    },
  };
}

// Pre-parse multipart/form-data using the Web `Request.formData()` API so we
// never hit `formidable` on the Workers runtime (formidable requires
// `fs.createWriteStream` for temp files, which Workers does not support even
// with `nodejs_compat_v2`). Returns a formidable-shaped object, or null if
// the request is not multipart.
//
// IMPORTANT: this consumes the request body, so it MUST run before `makeReq`
// locks the ReadableStream via `body.getReader()`.
async function preparseMultipart(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('multipart/form-data')) return null;

  const fd = await request.formData();
  const fields = {};
  const files = {};
  for (const [key, value] of fd.entries()) {
    // Duck-type check — File/Blob both expose arrayBuffer() and a name/type.
    if (value && typeof value.arrayBuffer === 'function') {
      const buf = Buffer.from(await value.arrayBuffer());
      files[key] = {
        buffer: buf,
        size: buf.length,
        originalFilename: value.name || 'upload.bin',
        newFilename: value.name || 'upload.bin',
        mimetype: value.type || 'application/octet-stream',
        filepath: null, // no disk file on Workers
      };
    } else {
      fields[key] = String(value);
    }
  }
  return { fields, files, isFormData: true };
}

export const onRequest = async ({ request }) => {
  try {
    const url = new URL(request.url);
    // Consume the body FIRST for multipart so we don't lock the stream twice.
    const preparsed = await preparseMultipart(request);
    const req = makeReq(request, url, { skipBody: Boolean(preparsed) });
    if (preparsed) req.__preparsedBody__ = preparsed;
    // Inject CF-runtime-only helpers. Presence of `__cfFetch__` on the
    // request is how `api/piapi.js` detects that it's running on Workers
    // and should route proxied requests through `cfFetch` instead of
    // `undici` / `https.request`, which don't work here.
    req.__cfFetch__ = cfFetch;
    req.__parseProxyUrl__ = parseProxyUrl;
    const { res, toResponse } = makeRes();
    // Kick off handler; it will call res.end/json/send when done.
    const p = piapiHandler(req, res);
    // Wait for either the handler to throw or the response to finish.
    await Promise.race([p, toResponse().then(() => {})]);
    return toResponse();
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
