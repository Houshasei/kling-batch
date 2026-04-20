/**
 * Cloudflare Pages Functions adapter.
 *
 * REQUIREMENT: enable the `nodejs_compat_v2` compatibility flag in your
 * Pages project settings (Settings → Functions → Compatibility flags).
 * Without it, `formidable`, `undici`, `socks-proxy-agent`, `https`, `net`,
 * `tls`, and `fs` will not work.
 *
 * Limitations on Workers runtime:
 *   - SOCKS5 proxying may or may not work depending on current support for
 *     the `net` module. HTTP fetch always works. If SOCKS5 fails on CF, use
 *     HTTP proxy mode in the UI or deploy to Vercel/Netlify/Node instead.
 *   - `formidable` requires writable temp dir; Workers provides one under
 *     /tmp when `nodejs_compat_v2` is enabled.
 *
 * Route: functions/api/piapi.js → handles /api/piapi for GET + POST.
 */

import { Readable } from 'node:stream';
import piapiHandler from '../../api/piapi.js';

function makeReq(request, url) {
  const headers = {};
  for (const [k, v] of request.headers.entries()) headers[k.toLowerCase()] = v;

  const query = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  let stream;
  if (request.body) {
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
// with `nodejs_compat_v2`). Result is attached to `req.__preparsedBody__` and
// `api/piapi.js` short-circuits `parseRequestBody` when that marker is set.
async function maybePreparseMultipart(request, req) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('multipart/form-data')) return;

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
  req.__preparsedBody__ = { fields, files, isFormData: true };
}

export const onRequest = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const req = makeReq(request, url);
    await maybePreparseMultipart(request, req);
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
