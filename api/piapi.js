import formidable from 'formidable';
import fs from 'fs';
import { ProxyAgent } from 'undici';

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
]);
const PROXY_FAIL_STATUSES = new Set([407, 429, 502, 503, 504]);

function classifyProxyFailure(err, status) {
  const code = err?.cause?.code || err?.code || '';
  if (PROXY_FAIL_CODES.has(code)) return { proxyFailed: true, code };
  if (PROXY_FAIL_STATUSES.has(status)) return { proxyFailed: true, code: code || undefined };
  return { proxyFailed: false, code: code || undefined };
}

async function uploadToLitterbox(buffer, filename, mime, { dispatcher } = {}) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', '1h');
  fd.append('fileToUpload', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const r = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
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

async function uploadToTmpfile(buffer, filename, mime, { dispatcher } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const r = await fetch('https://api.secretme.cn/api/upload', {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    body: fd,
    dispatcher,
  });
  const { json, text } = await readAsJsonOrText(r);

  if (!r.ok) {
    throw makeUploadError(`tmpfile upload failed (${r.status})`, r.status, text);
  }
  const url = json?.downloadUrl || json?.data?.downloadUrl;
  if (!json?.success || !url || !/^https?:\/\//i.test(url)) {
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

  let action, apiKey, payload, host, proxyUrl, webshareKey;

  if (parsed.isFormData) {
    action = fieldValue(parsed.fields, 'action');
    apiKey = fieldValue(parsed.fields, 'apiKey');
    host = fieldValue(parsed.fields, 'host');
    proxyUrl = fieldValue(parsed.fields, 'proxyUrl');
    payload = { fields: parsed.fields, files: parsed.files };
  } else {
    ({ action, apiKey, host, proxyUrl, webshareKey, ...payload } = parsed.body || {});
  }

  const needsApiKey = ['create', 'poll'].includes(action);
  if (needsApiKey && !apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  try {
    if (action === 'create' || action === 'poll') {
      let dispatcher;
      if (proxyUrl && /^https?:\/\//i.test(proxyUrl)) {
        try {
          dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
          return res.status(400).json({ error: `Invalid proxy URL: ${err.message}`, proxyFailed: true });
        }
      }
      try {
        let r;
        if (action === 'create') {
          r = await fetch('https://api.piapi.ai/api/v1/task', {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload.taskBody),
            dispatcher,
          });
        } else {
          r = await fetch('https://api.piapi.ai/api/v1/task/' + payload.taskId, {
            method: 'GET',
            headers: { 'x-api-key': apiKey },
            dispatcher,
          });
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
        const { proxyFailed, code } = classifyProxyFailure(err, 0);
        return res.status(proxyFailed ? 502 : 500).json({
          error: err.message,
          proxyFailed: Boolean(proxyUrl) && proxyFailed,
          code,
        });
      } finally {
        try { dispatcher?.close?.(); } catch (_) {}
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

      let dispatcher;
      if (proxyUrl && /^https?:\/\//i.test(proxyUrl)) {
        try {
          dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
          try { await fs.promises.unlink(file.filepath); } catch (_) {}
          return res.status(400).json({ error: `Invalid proxy URL: ${err.message}`, proxyFailed: true });
        }
      }

      try {
        const { url, raw } = await hostDef.upload(buffer, fileName, mime, { dispatcher });
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
        const { proxyFailed, code } = classifyProxyFailure(err, status);
        const pf = Boolean(proxyUrl) && proxyFailed;
        return res.status(pf ? 502 : status).json({
          error: err.message,
          host: chosenHost,
          body: err.body || null,
          proxyFailed: pf,
          code,
        });
      } finally {
        try { dispatcher?.close?.(); } catch (_) {}
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
        for (const p of results) {
          const u = `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.proxy_address}:${p.port}`;
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
