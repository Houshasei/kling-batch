/**
 * Universal Node server.
 *
 * Works anywhere Node.js runs: Replit, Render, Railway, Fly.io, Docker, VPS.
 *
 * - Serves the built SPA from ./dist
 * - Mounts the Vercel-style serverless handler at /api/piapi
 * - Adapts req/res minimally (adds req.query + a status/json/send shim)
 *
 * Usage:
 *   npm run build
 *   npm start              # respects PORT env (default 3000)
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import piapiHandler from './api/piapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

function wrapRes(res) {
  return {
    status(code) { res.status(code); return this; },
    setHeader(name, value) { res.setHeader(name, value); return this; },
    json(payload) { res.json(payload); return this; },
    send(payload) { res.send(payload); return this; },
    end(payload) { res.end(payload); return this; },
    get headersSent() { return res.headersSent; },
  };
}

// The handler disables Express's bodyParser (it parses multipart itself via formidable
// and JSON via a raw stream reader). We mount it raw, without any body middleware.
app.all('/api/piapi', async (req, res) => {
  try {
    req.query = req.query || {};
    await piapiHandler(req, wrapRes(res));
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Server error' });
    }
  }
});

// Static SPA
const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir, { index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

app.listen(port, host, () => {
  console.log(`kling-batch listening on http://${host}:${port}`);
});
