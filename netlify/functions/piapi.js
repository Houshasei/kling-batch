/**
 * Netlify Functions adapter.
 *
 * Netlify invokes this with (event, context) → we fabricate a Node IncomingMessage-
 * like req and a Node ServerResponse-like res and delegate to the existing handler.
 *
 * Config is in netlify.toml (publish dir, functions dir, /api/piapi redirect).
 */

import { Readable } from 'node:stream';
import piapiHandler from '../../api/piapi.js';

export const config = { path: '/api/piapi' };

function bufferFromEvent(event) {
  if (!event.body) return Buffer.alloc(0);
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64');
  return Buffer.from(event.body, 'utf8');
}

// Build a Node-style IncomingMessage that piapi.js can read via req.on('data'|'end') and formidable can parse.
function makeReq(event) {
  const bodyBuf = bufferFromEvent(event);
  const stream = Readable.from([bodyBuf]);
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  // Ensure content-length matches the decoded body so formidable can parse multipart correctly.
  if (bodyBuf.length) headers['content-length'] = String(bodyBuf.length);

  // Query
  const query = {};
  const qsp = event.queryStringParameters || {};
  for (const k of Object.keys(qsp)) query[k] = qsp[k];

  // Compose into the readable stream so all .on('data'/'end') consumers work.
  Object.assign(stream, {
    method: event.httpMethod,
    url: event.rawUrl || event.path || '/api/piapi',
    headers,
    query,
  });
  return stream;
}

function makeRes(resolve) {
  let statusCode = 200;
  const headers = {};
  const chunks = [];

  const res = {
    status(code) { statusCode = code; return this; },
    setHeader(name, value) { headers[name] = value; return this; },
    getHeader(name) { return headers[name]; },
    json(payload) {
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json; charset=utf-8';
      chunks.push(Buffer.from(JSON.stringify(payload)));
      finish();
      return this;
    },
    send(payload) {
      if (Buffer.isBuffer(payload)) chunks.push(payload);
      else if (typeof payload === 'string') chunks.push(Buffer.from(payload));
      else if (payload != null) {
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json; charset=utf-8';
        chunks.push(Buffer.from(JSON.stringify(payload)));
      }
      finish();
      return this;
    },
    end(payload) {
      if (payload) {
        if (Buffer.isBuffer(payload)) chunks.push(payload);
        else chunks.push(Buffer.from(String(payload)));
      }
      finish();
      return this;
    },
    get headersSent() { return finished; },
  };

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    const body = Buffer.concat(chunks);
    // Binary responses (e.g. download_proxy) must be base64.
    const ct = (headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
    const isText = ct.startsWith('application/json') || ct.startsWith('text/');
    resolve({
      statusCode,
      headers,
      body: isText ? body.toString('utf8') : body.toString('base64'),
      isBase64Encoded: !isText,
    });
  }
  return res;
}

export default async (event) => {
  return new Promise(async (resolve) => {
    try {
      const req = makeReq(event);
      const res = makeRes(resolve);
      await piapiHandler(req, res);
    } catch (err) {
      resolve({
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err?.message || 'Server error' }),
      });
    }
  });
};
