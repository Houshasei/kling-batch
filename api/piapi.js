import formidable from 'formidable';
import fs from 'fs';
import https from 'https';
import { SocksProxyAgent } from 'socks-proxy-agent';

// Hand-rolled multipart/form-data builder. Used on the SOCKS5 path (which
// pipes raw bytes through `https.request` and can't use the Web-standard
// `fetch` + `FormData` combo) and anywhere we need deterministic bytes
// without pulling in the `form-data` npm package, whose `.getHeaders()` is
// broken on Cloudflare Workers' `nodejs_compat_v2` shim.
function buildMultipart(parts) {
  const boundary = `----KlingBatchBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const CRLF = '\r\n';
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`));
    if (p.filename != null) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${CRLF}` +
        `Content-Type: ${p.contentType || 'application/octet-stream'}${CRLF}${CRLF}`,
      ));
      chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"${CRLF}${CRLF}${String(p.value)}`,
      ));
    }
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  const body = Buffer.concat(chunks);
  return {
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
  };
}

// Global `fetch` is available on Node 18+, Cloudflare Workers, Netlify
// Functions, Vercel Edge/Node, and browsers. That covers every runtime we
// ship to; we no longer depend on undici. SOCKS5 is the only supported
// proxy protocol — HTTP proxies have been removed because Cloudflare's
// `unenv` doesn't implement `https.request` / `node:sqlite`, forcing us
// to keep a single tunneling path (`cfFetch` on CF, `socks-proxy-agent`
// + `https.request` on Node).

// Cloudflare Workers / Pages Functions expose a global `navigator.userAgent`
// of 'Cloudflare-Workers'. Used both to route proxied requests through our
// custom `cfFetch` client and to fail loudly if the CF adapter hasn't wired
// it up.
function isCloudflareWorkers() {
  try {
    const ua = globalThis?.navigator?.userAgent || '';
    return ua.includes('Cloudflare-Workers');
  } catch (_) {
    return false;
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

const UA = 'kling-batch/1.0 (+https://github.com/Houshasei/kling-batch)';
const API_KEY_ACTIONS = new Set(['create', 'poll', 'account_info']);
const ACCOUNT_ACTION_URLS = {
  account_info: 'https://api.piapi.ai/account/info',
};

async function readAsJsonOrText(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch (_) {
    return { json: null, text };
  }
}

async function parseRequestBody(req) {
  // If an adapter (e.g. Cloudflare Pages Functions) already parsed the body
  // using a runtime-appropriate API, use that instead of touching formidable.
  if (req.__preparsedBody__) return req.__preparsedBody__;

  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    return new Promise((resolve, reject) => {
      const form = formidable({
        maxFileSize: 100 * 1024 * 1024,
        keepExtensions: true,
      });
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files, isFormData: true });
      });
    });
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve({ body: body ? JSON.parse(body) : {}, isFormData: false });
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function fieldValue(fields, key) {
  const v = fields?.[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

function makeUploadError(message, status, body) {
  const err = new Error(message);
  err.status = status;
  err.body = body;
  return err;
}

const PROXY_FAIL_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPROTO',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'ERR_SOCKS_INVALID_SOCKS_VERSION', 'ERR_SOCKS_AUTHENTICATION_FAILED',
  'ERR_SOCKS_CONNECTION_TIMEOUT', 'ERR_SOCKS_CONNECTION_REFUSED',
  'ERR_SOCKS_PROXY_CLOSED_SOCKET', 'ERR_SOCKS_PROTOCOL',
]);
const PROXY_FAIL_STATUSES = new Set([407, 429, 502, 503, 504]);

function classifyProxyFailure(err, status) {
  const code = err?.cause?.code || err?.code || '';
  const msg = err?.cause?.message || err?.message || '';
  const detail = [err?.message, err?.cause?.message].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' | ');
  if (PROXY_FAIL_CODES.has(code)) return { proxyFailed: true, code, detail };
  if (PROXY_FAIL_STATUSES.has(status)) return { proxyFailed: true, code: code || undefined, detail };
  if (/^SOCKS\b/i.test(msg) || /socks/i.test(err?.name || '')) {
    return { proxyFailed: true, code: code || 'SOCKS_ERROR', detail };
  }
  return { proxyFailed: false, code: code || undefined, detail };
}

// Build a proxy handle appropriate for the current runtime. SOCKS5-only.
//
//   - On Cloudflare Workers: `req.__cfFetch__` is attached by the Pages
//     adapter. SOCKS5 proxies route through that custom HTTP client
//     (see functions/lib/cf-http.js).
//   - On Node-like runtimes (Vercel/Netlify/Replit/local): `socks-proxy-agent`
//     + `https.request`.
//
// HTTP/HTTPS proxies are rejected outright — Cloudflare's `unenv` shim
// lacks `node:sqlite` (undici) and `https.request`, so there is no single
// proxy code path that works everywhere. Configure your Webshare account
// to expose SOCKS5 proxies instead.
async function prepProxy(proxyUrl, req) {
  if (!proxyUrl) return {};

  // Cloudflare Pages / Workers: proxies are disabled entirely. The
  // `cloudflare:sockets` runtime adds too much latency and unreliability
  // when tunneling through SOCKS5, and tmpfile/litterbox's CDN blocks most
  // of the residential IPs Webshare hands out anyway. Silently drop the
  // proxy and fall through to the direct-egress path (CF's own network).
  // `proxyDroppedOnCF: true` is surfaced in the response so the SPA can
  // optionally show a one-time notice.
  if (isCloudflareWorkers()) {
    return { proxyDroppedOnCF: true };
  }

  const u = new URL(proxyUrl);
  const isSocks = u.protocol === 'socks5:' || u.protocol === 'socks:' || u.protocol === 'socks5h:';

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const e = new Error('HTTP/HTTPS proxies are no longer supported. Use a SOCKS5 proxy URL (socks5://user:pass@host:port).');
    e.code = 'ERR_PROXY_HTTP_REMOVED';
    throw e;
  }
  if (!isSocks) {
    const e = new Error(`Unsupported proxy protocol: ${u.protocol}`);
    e.code = 'ERR_PROXY_UNSUPPORTED';
    throw e;
  }

  // Cloudflare Workers path: use the injected cfFetch.
  if (req?.__cfFetch__ && req?.__parseProxyUrl__) {
    const proxyCfg = req.__parseProxyUrl__(proxyUrl);
    if (!proxyCfg) {
      const e = new Error(`Unsupported proxy protocol: ${u.protocol}`);
      e.code = 'ERR_PROXY_UNSUPPORTED';
      throw e;
    }
    return { kind: 'cf', cfProxy: proxyCfg, cfFetch: req.__cfFetch__ };
  }

  // Hard guard: if we're running on Cloudflare but the adapter didn't inject
  // `__cfFetch__`, we MUST NOT fall through to the Node SOCKS path — that
  // would try to call `https.request`, which `unenv` doesn't implement,
  // producing the cryptic `[unenv] https.request is not implemented yet!`
  // error. Fail loudly with an actionable message instead.
  if (isCloudflareWorkers()) {
    const e = new Error('Cloudflare adapter missing: functions/api/piapi.js did not inject cfFetch. Redeploy the Pages project from the current source — the CF proxy runtime needs functions/lib/cf-http.js.');
    e.code = 'ERR_CF_ADAPTER_MISSING';
    throw e;
  }

  // Node-like path.
  return {
    socksAgent: new SocksProxyAgent(proxyUrl, { timeout: 30000 }),
    kind: 'socks5',
  };
}

function closeProxy(proxy) {
  try { proxy?.socksAgent?.destroy?.(); } catch (_) {}
}

// Native https.request wrapper that mimics the subset of fetch Response we use.
function httpsRequestViaSocks(url, { method = 'GET', headers = {}, body, agent, timeoutMs = 60000 } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      agent,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: {
            get: (k) => res.headers[String(k).toLowerCase()],
          },
          text: async () => text,
          _buffer: buf,
        });
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') {
      body.pipe(req);
    } else if (body != null) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

async function uploadToLitterbox(buffer, filename, mime, { socksAgent, cfFetch, cfProxy } = {}) {
  const endpoint = 'https://litterbox.catbox.moe/resources/internals/api.php';

  // Cloudflare runtime — send raw multipart bytes through our custom HTTP
  // client (supports SOCKS5 and HTTP CONNECT proxies on top of cloudflare:sockets).
  if (cfFetch) {
    const { body, headers: mpHeaders } = buildMultipart([
      { name: 'reqtype', value: 'fileupload' },
      { name: 'time', value: '1h' },
      { name: 'fileToUpload', value: buffer, filename, contentType: mime || 'application/octet-stream' },
    ]);
    const r = await cfFetch(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'text/plain', ...mpHeaders },
      body,
      proxy: cfProxy || null,
    });
    const text = await r.text();
    const url = (text || '').trim();
    if (!r.ok || !/^https?:\/\//i.test(url)) {
      throw makeUploadError(`Litterbox upload failed (${r.status})`, r.status, text);
    }
    return { url, raw: text };
  }

  if (socksAgent) {
    const { body, headers: mpHeaders } = buildMultipart([
      { name: 'reqtype', value: 'fileupload' },
      { name: 'time', value: '1h' },
      { name: 'fileToUpload', value: buffer, filename, contentType: mime || 'application/octet-stream' },
    ]);
    const r = await httpsRequestViaSocks(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'text/plain', ...mpHeaders },
      body,
      agent: socksAgent,
    });
    const text = await r.text();
    const url = (text || '').trim();
    if (!r.ok || !/^https?:\/\//i.test(url)) {
      throw makeUploadError(`Litterbox upload failed (${r.status})`, r.status, text);
    }
    return { url, raw: text };
  }

  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', '1h');
  fd.append('fileToUpload', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'text/plain' },
    body: fd,
  });
  const { text } = await readAsJsonOrText(r);
  const url = (text || '').trim();

  if (!r.ok || !/^https?:\/\//i.test(url)) {
    throw makeUploadError(`Litterbox upload failed (${r.status})`, r.status, text);
  }
  return { url, raw: text };
}

async function uploadToTmpfile(buffer, filename, mime, { socksAgent, cfFetch, cfProxy } = {}) {
  const endpoint = 'https://tmpfile.link/api/upload';

  if (cfFetch) {
    const { body, headers: mpHeaders } = buildMultipart([
      { name: 'file', value: buffer, filename, contentType: mime || 'application/octet-stream' },
    ]);
    const r = await cfFetch(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...mpHeaders },
      body,
      proxy: cfProxy || null,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    if (!r.ok) {
      throw makeUploadError(`tmpfile upload failed (${r.status})`, r.status, text);
    }
    const url = json?.downloadLink || json?.data?.downloadLink;
    if (!url || !/^https?:\/\//i.test(url)) {
      throw makeUploadError('tmpfile returned invalid response', r.status, text);
    }
    return { url, raw: text };
  }

  if (socksAgent) {
    const { body, headers: mpHeaders } = buildMultipart([
      { name: 'file', value: buffer, filename, contentType: mime || 'application/octet-stream' },
    ]);
    const r = await httpsRequestViaSocks(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...mpHeaders },
      body,
      agent: socksAgent,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    if (!r.ok) {
      throw makeUploadError(`tmpfile upload failed (${r.status})`, r.status, text);
    }
    const url = json?.downloadLink || json?.data?.downloadLink;
    if (!url || !/^https?:\/\//i.test(url)) {
      throw makeUploadError('tmpfile returned invalid response', r.status, text);
    }
    return { url, raw: text };
  }

  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    body: fd,
  });
  const { json, text } = await readAsJsonOrText(r);

  if (!r.ok) {
    throw makeUploadError(`tmpfile upload failed (${r.status})`, r.status, text);
  }
  const url = json?.downloadLink || json?.data?.downloadLink;
  if (!url || !/^https?:\/\//i.test(url)) {
    throw makeUploadError('tmpfile returned invalid response', r.status, text);
  }
  return { url, raw: text };
}

// Host registry — add a new host by adding one entry + one uploader above.
function normalizeTmpfilesUrl(url) {
  const u = new URL(url);
  if (u.hostname === 'tmpfiles.org' && !u.pathname.startsWith('/dl/')) {
    u.pathname = `/dl${u.pathname.startsWith('/') ? '' : '/'}${u.pathname}`;
  }
  return u.toString();
}

function extractTmpfilesUrl(text, status) {
  let json; try { json = JSON.parse(text); } catch (_) { json = null; }
  const rawUrl = json?.data?.url || json?.url;
  if (json?.status && json.status !== 'success') {
    throw makeUploadError(`tmpfiles.org upload failed: ${json?.message || json?.error || json.status}`, status, text);
  }
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    throw makeUploadError('tmpfiles.org returned invalid response', status, text);
  }
  return normalizeTmpfilesUrl(rawUrl);
}

async function uploadToTmpfiles(buffer, filename, mime, { socksAgent, cfFetch, cfProxy } = {}) {
  const endpoint = 'https://tmpfiles.org/api/v1/upload';

  if (cfFetch) {
    const { body, headers: mpHeaders } = buildMultipart([
      { name: 'file', value: buffer, filename, contentType: mime || 'application/octet-stream' },
    ]);
    const r = await cfFetch(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...mpHeaders },
      body,
      proxy: cfProxy || null,
    });
    const text = await r.text();
    if (!r.ok) {
      throw makeUploadError(`tmpfiles.org upload failed (${r.status})`, r.status, text);
    }
    return { url: extractTmpfilesUrl(text, r.status), raw: text };
  }

  if (socksAgent) {
    const { body, headers: mpHeaders } = buildMultipart([
      { name: 'file', value: buffer, filename, contentType: mime || 'application/octet-stream' },
    ]);
    const r = await httpsRequestViaSocks(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...mpHeaders },
      body,
      agent: socksAgent,
    });
    const text = await r.text();
    if (!r.ok) {
      throw makeUploadError(`tmpfiles.org upload failed (${r.status})`, r.status, text);
    }
    return { url: extractTmpfilesUrl(text, r.status), raw: text };
  }

  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    body: fd,
  });
  const { text } = await readAsJsonOrText(r);

  if (!r.ok) {
    throw makeUploadError(`tmpfiles.org upload failed (${r.status})`, r.status, text);
  }
  return { url: extractTmpfilesUrl(text, r.status), raw: text };
}

const HOSTS = {
  litterbox: { upload: uploadToLitterbox },
  tmpfile: { upload: uploadToTmpfile },
  tmpfiles: { upload: uploadToTmpfiles },
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { action, url, filename } = req.query || {};

    // Lightweight capability probe used by the SPA at boot to hide features
    // that are unsupported on the current runtime (e.g. proxy UI on CF).
    if (action === 'runtime_info') {
      const cf = isCloudflareWorkers();
      return res.status(200).json({
        runtime: cf ? 'cloudflare' : 'node',
        proxySupported: !cf,
      });
    }

    if (action !== 'download_proxy') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!url) {
      return res.status(400).json({ error: 'Missing url' });
    }

    try {
      const r = await fetch(String(url));
      if (!r.ok) {
        return res.status(r.status).json({ error: 'Failed to fetch remote file' });
      }
      const contentType = r.headers.get('content-type') || 'application/octet-stream';
      const safeName = String(filename || 'video-download.mp4').replace(/[\r\n"]/g, '');
      const buffer = Buffer.from(await r.arrayBuffer());

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      return res.status(200).send(buffer);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let parsed;
  try {
    parsed = await parseRequestBody(req);
  } catch (err) {
    return res.status(400).json({ error: `Request parse failed: ${err.message}` });
  }

  let action, apiKey, payload, host, proxyUrl, webshareKey, protocol;

  if (parsed.isFormData) {
    action = fieldValue(parsed.fields, 'action');
    apiKey = fieldValue(parsed.fields, 'apiKey');
    host = fieldValue(parsed.fields, 'host');
    proxyUrl = fieldValue(parsed.fields, 'proxyUrl');
    protocol = fieldValue(parsed.fields, 'protocol');
    payload = { fields: parsed.fields, files: parsed.files };
  } else {
    ({ action, apiKey, host, proxyUrl, webshareKey, protocol, ...payload } = parsed.body || {});
  }

  const needsApiKey = API_KEY_ACTIONS.has(action);
  if (needsApiKey && !apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  try {
    if (ACCOUNT_ACTION_URLS[action]) {
      const r = await fetch(ACCOUNT_ACTION_URLS[action], {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          Accept: 'application/json',
        },
      });
      const text = await r.text();
      let d; try { d = JSON.parse(text); } catch (_) { d = null; }
      return res.status(r.status).json(d || { error: text || `PiAPI HTTP ${r.status}` });
    }

    if (action === 'create' || action === 'poll') {
      let proxy = {};
      if (proxyUrl) {
        try {
          proxy = await prepProxy(proxyUrl, req);
        } catch (err) {
          return res.status(400).json({ error: `Invalid proxy URL: ${err.message}`, proxyFailed: true, code: err.code });
        }
      }
      try {
        const isCreate = action === 'create';
        const url = isCreate
          ? 'https://api.piapi.ai/api/v1/task'
          : 'https://api.piapi.ai/api/v1/task/' + payload.taskId;
        const method = isCreate ? 'POST' : 'GET';
        const headers = isCreate
          ? { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
          : { 'x-api-key': apiKey };
        const body = isCreate ? JSON.stringify(payload.taskBody) : undefined;

        let r;
        if (proxy.kind === 'cf') {
          r = await proxy.cfFetch(url, { method, headers, body, proxy: proxy.cfProxy });
        } else if (proxy.socksAgent) {
          r = await httpsRequestViaSocks(url, { method, headers, body, agent: proxy.socksAgent });
        } else {
          r = await fetch(url, { method, headers, body });
        }
        const text = await r.text();
        let d; try { d = JSON.parse(text); } catch (_) { d = { error: text }; }
        if (!r.ok && proxyUrl) {
          const { proxyFailed, code } = classifyProxyFailure(null, r.status);
          if (proxyFailed) {
            return res.status(r.status).json({
              ...(d || {}),
              error: d?.error || d?.message || `HTTP ${r.status}`,
              proxyFailed: true,
              code,
            });
          }
        }
        return res.status(r.status).json(d);
      } catch (err) {
        const { proxyFailed, code, detail } = classifyProxyFailure(err, 0);
        return res.status(proxyFailed ? 502 : 500).json({
          error: detail || err.message,
          proxyFailed: Boolean(proxyUrl) && proxyFailed,
          code,
        });
      } finally {
        closeProxy(proxy);
      }
    }

    if (action === 'upload_file') {
      if (!parsed.isFormData) {
        return res.status(400).json({ error: 'upload_file requires multipart/form-data' });
      }

      const fileEntry = payload.files.file;
      const file = Array.isArray(fileEntry) ? fileEntry[0] : fileEntry;
      if (!file) {
        return res.status(400).json({ error: 'Missing file in FormData' });
      }

      const chosenHost = (host || 'litterbox').toLowerCase();
      const hostDef = HOSTS[chosenHost];
      if (!hostDef) {
        if (file.filepath) { try { await fs.promises.unlink(file.filepath); } catch (_) {} }
        return res.status(400).json({ error: `Unknown host: ${chosenHost}` });
      }

      // Prefer an in-memory buffer (provided by adapters on runtimes with no
      // writable FS, e.g. Cloudflare Workers). Fall back to reading the temp
      // file that formidable wrote on Node-capable hosts.
      const buffer = file.buffer || await fs.promises.readFile(file.filepath);
      const fileName = file.originalFilename || file.newFilename || 'upload.bin';
      const mime = file.mimetype || 'application/octet-stream';

      let proxy = {};
      if (proxyUrl) {
        try {
          proxy = await prepProxy(proxyUrl, req);
        } catch (err) {
          if (file.filepath) { try { await fs.promises.unlink(file.filepath); } catch (_) {} }
          return res.status(400).json({ error: `Invalid proxy URL: ${err.message}`, proxyFailed: true, code: err.code });
        }
      }

      try {
        const { url, raw } = await hostDef.upload(buffer, fileName, mime, {
          socksAgent: proxy.socksAgent,
          cfFetch: proxy.kind === 'cf' ? proxy.cfFetch : null,
          cfProxy: proxy.kind === 'cf' ? proxy.cfProxy : null,
        });
        return res.status(200).json({
          proxyDroppedOnCF: proxy.proxyDroppedOnCF || false,
          data: {
            fileName,
            downloadLink: url,
            downloadLinkEncoded: url,
            uploadedTo: chosenHost,
            type: mime,
            size: buffer.length,
            usedProxy: Boolean(proxyUrl),
          },
          raw,
        });
      } catch (err) {
        const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
        const { proxyFailed, code, detail } = classifyProxyFailure(err, status);
        const pf = Boolean(proxyUrl) && proxyFailed;
        return res.status(pf ? 502 : status).json({
          error: detail || err.message,
          host: chosenHost,
          body: err.body || null,
          proxyFailed: pf,
          code,
        });
      } finally {
        closeProxy(proxy);
        if (file.filepath) { try { await fs.promises.unlink(file.filepath); } catch (_) {} }
      }
    }

    if (action === 'list_proxies') {
      const key = webshareKey || apiKey;
      if (!key) {
        return res.status(400).json({ error: 'Missing webshareKey' });
      }
      const proxies = [];
      let page = 1;
      const maxPages = 20; // safety cap (2000 proxies)
      while (page <= maxPages) {
        const url = `https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=${page}&page_size=100`;
        const r = await fetch(url, { headers: { Authorization: `Token ${key}` } });
        const text = await r.text();
        let json; try { json = JSON.parse(text); } catch (_) { json = null; }
        if (!r.ok) {
          return res.status(r.status).json({ error: json?.detail || json?.error || `Webshare HTTP ${r.status}`, body: text.slice(0, 500) });
        }
        const results = Array.isArray(json?.results) ? json.results : [];
        // HTTP proxies are removed; always request SOCKS5 URLs from Webshare.
        const scheme = 'socks5';
        for (const p of results) {
          const u = `${scheme}://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.proxy_address}:${p.port}`;
          proxies.push({ id: String(p.id ?? `${p.proxy_address}:${p.port}`), url: u, country: p.country_code || null });
        }
        if (!json?.next) break;
        page += 1;
      }
      return res.status(200).json({ count: proxies.length, proxies });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
