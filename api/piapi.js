import formidable from 'formidable';
import fs from 'fs';

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

async function uploadTo0x0(buffer, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const r = await fetch('https://0x0.st', {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'text/plain' },
    body: fd,
  });
  const { json, text } = await readAsJsonOrText(r);
  const url = (text || '').trim();

  if (!r.ok || !/^https?:\/\//i.test(url)) {
    const err = new Error(`0x0.st upload failed (${r.status})`);
    err.status = r.status;
    err.body = text || (json && JSON.stringify(json));
    throw err;
  }
  return { url, raw: text };
}

async function uploadToLitterbox(buffer, filename, mime) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', '1h');
  fd.append('fileToUpload', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const r = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'text/plain' },
    body: fd,
  });
  const { json, text } = await readAsJsonOrText(r);
  const url = (text || '').trim();

  if (!r.ok || !/^https?:\/\//i.test(url)) {
    const err = new Error(`Litterbox upload failed (${r.status})`);
    err.status = r.status;
    err.body = text || (json && JSON.stringify(json));
    throw err;
  }
  return { url, raw: text };
}

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

  let action, apiKey, payload, host;

  if (parsed.isFormData) {
    action = fieldValue(parsed.fields, 'action');
    apiKey = fieldValue(parsed.fields, 'apiKey');
    host = fieldValue(parsed.fields, 'host');
    payload = { fields: parsed.fields, files: parsed.files };
  } else {
    ({ action, apiKey, host, ...payload } = parsed.body || {});
  }

  const needsApiKey = ['create', 'poll'].includes(action);
  if (needsApiKey && !apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  try {
    if (action === 'create') {
      const r = await fetch('https://api.piapi.ai/api/v1/task', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.taskBody),
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    }

    if (action === 'poll') {
      const r = await fetch('https://api.piapi.ai/api/v1/task/' + payload.taskId, {
        method: 'GET',
        headers: { 'x-api-key': apiKey },
      });
      const d = await r.json();
      return res.status(r.status).json(d);
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
      if (!['litterbox', '0x0'].includes(chosenHost)) {
        try { await fs.promises.unlink(file.filepath); } catch (_) {}
        return res.status(400).json({ error: `Unknown host: ${chosenHost}` });
      }

      const buffer = await fs.promises.readFile(file.filepath);
      const fileName = file.originalFilename || file.newFilename || 'upload.bin';
      const mime = file.mimetype || 'application/octet-stream';

      try {
        const uploader = chosenHost === '0x0' ? uploadTo0x0 : uploadToLitterbox;
        const { url, raw } = await uploader(buffer, fileName, mime);

        return res.status(200).json({
          data: {
            fileName,
            downloadLink: url,
            downloadLinkEncoded: url,
            uploadedTo: chosenHost,
            type: mime,
            size: buffer.length,
          },
          raw,
        });
      } catch (err) {
        return res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502).json({
          error: err.message,
          host: chosenHost,
          body: err.body || null,
        });
      } finally {
        try { await fs.promises.unlink(file.filepath); } catch (_) {}
      }
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
