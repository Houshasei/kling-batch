import formidable from 'formidable';
import fs from 'fs';
import https from 'https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import NodeFormData from 'form-data';

// Global `fetch` and `FormData` are available on Node 18+, Cloudflare Workers,
// Netlify Functions, Vercel Edge/Node, and browsers. We use them directly
// and only fall back to undici's ProxyAgent when an HTTP proxy is in play.
//
// undici is loaded via a variable-path dynamic import so esbuild (Cloudflare's
// Pages bundler) can't statically trace into its `node:sqlite` cache-store code
// and will leave it unbundled. On real Node, the import resolves at runtime.
const UNDICI_MODULE_ID = 'undici';
let _undiciCache = null;
async function loadUndici() {
  if (_undiciCache) return _undiciCache;
  try {
    const mod = await import(/* @vite-ignore */ UNDICI_MODULE_ID);
    _undiciCache = { ok: true, ProxyAgent: mod.ProxyAgent };
  } catch (err) {
    _undiciCache = { ok: false, error: err };
  }
  return _undiciCache;
}

// Cloudflare Workers / Pages Functions expose a global `navigator.userAgent`
// of 'Cloudflare-Workers'. Use that to detect the runtime and refuse HTTP
// proxy requests up-front with a clear error instead of failing opaquely.
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

async function readAsJsonOrText(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch (_) {
    return { json: null, text };
  }
}

async function parseRequestBody(req) {
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

// Build either an undici Dispatcher (HTTP/HTTPS proxy) or a native https Agent (SOCKS5).
async function prepProxy(proxyUrl) {
  if (!proxyUrl) return {};
  const u = new URL(proxyUrl);

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (isCloudflareWorkers()) {
      const e = new Error('HTTP proxy is not supported on Cloudflare Pages/Workers. Use SOCKS5 or deploy the backend to Vercel / Netlify / Node.');
      e.code = 'ERR_PROXY_HTTP_UNSUPPORTED_ON_CF';
      throw e;
    }
    const undici = await loadUndici();
    if (!undici.ok) {
      const e = new Error(`HTTP proxy requires undici, which failed to load on this runtime: ${undici.error?.message || 'unknown error'}`);
      e.code = 'ERR_PROXY_UNDICI_UNAVAILABLE';
      throw e;
    }
    return { dispatcher: new undici.ProxyAgent(proxyUrl), kind: 'http' };
  }

  if (u.protocol === 'socks5:' || u.protocol === 'socks:' || u.protocol === 'socks5h:') {
    return {
      socksAgent: new SocksProxyAgent(proxyUrl, { timeout: 30000 }),
      kind: 'socks5',
    };
  }

  const e = new Error(`Unsupported proxy protocol: ${u.protocol}`);
  e.code = 'ERR_PROXY_UNSUPPORTED';
  throw e;
}

function closeProxy(proxy) {
  try { proxy?.dispatcher?.close?.(); } catch (_) {}
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

async function uploadToLitterbox(buffer, filename, mime, { dispatcher, socksAgent } = {}) {
  const endpoint = 'https://litterbox.catbox.moe/resources/internals/api.php';

  if (socksAgent) {
    const fd = new NodeFormData();
    fd.append('reqtype', 'fileupload');
    fd.append('time', '1h');
    fd.append('fileToUpload', buffer, { filename, contentType: mime || 'application/octet-stream' });
    const r = await httpsRequestViaSocks(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'text/plain', ...fd.getHeaders() },
      body: fd,
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
    dispatcher,
  });
  const { text } = await readAsJsonOrText(r);
  const url = (text || '').trim();

  if (!r.ok || !/^https?:\/\//i.test(url)) {
    throw makeUploadError(`Litterbox upload failed (${r.status})`, r.status, text);
  }
  return { url, raw: text };
}

async function uploadToTmpfile(buffer, filename, mime, { dispatcher, socksAgent } = {}) {
  const endpoint = 'https://tmpfile.link/api/upload';

  if (socksAgent) {
    const fd = new NodeFormData();
    fd.append('file', buffer, { filename, contentType: mime || 'application/octet-stream' });
    const r = await httpsRequestViaSocks(endpoint, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...fd.getHeaders() },
      body: fd,
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
    dispatcher,
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
const HOSTS = {
  litterbox: { upload: uploadToLitterbox },
  tmpfile: { upload: uploadToTmpfile },
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { action, url, filename } = req.query || {};

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

  const needsApiKey = ['create', 'poll'].includes(action);
  if (needsApiKey && !apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  try {
    if (action === 'create' || action === 'poll') {
      let proxy = {};
      if (proxyUrl) {
        try {
          proxy = await prepProxy(proxyUrl);
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
        if (proxy.socksAgent) {
          r = await httpsRequestViaSocks(url, { method, headers, body, agent: proxy.socksAgent });
        } else {
          r = await fetch(url, { method, headers, body, dispatcher: proxy.dispatcher });
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
        try { await fs.promises.unlink(file.filepath); } catch (_) {}
        return res.status(400).json({ error: `Unknown host: ${chosenHost}` });
      }

      const buffer = await fs.promises.readFile(file.filepath);
      const fileName = file.originalFilename || file.newFilename || 'upload.bin';
      const mime = file.mimetype || 'application/octet-stream';

      let proxy = {};
      if (proxyUrl) {
        try {
          proxy = await prepProxy(proxyUrl);
        } catch (err) {
          try { await fs.promises.unlink(file.filepath); } catch (_) {}
          return res.status(400).json({ error: `Invalid proxy URL: ${err.message}`, proxyFailed: true, code: err.code });
        }
      }

      try {
        const { url, raw } = await hostDef.upload(buffer, fileName, mime, {
          dispatcher: proxy.dispatcher,
          socksAgent: proxy.socksAgent,
        });
        return res.status(200).json({
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
        try { await fs.promises.unlink(file.filepath); } catch (_) {}
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
        const scheme = protocol === 'socks5' ? 'socks5' : 'http';
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
