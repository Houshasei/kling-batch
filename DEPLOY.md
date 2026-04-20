# Deployment Guide

Kling Batch works on every major Node-capable host. The backend handler in
`api/piapi.js` is a **Node.js serverless function**, so any host that runs
Node works out of the box.

## Quick compatibility matrix

| Host | SPA | Backend | Proxies (HTTP) | Proxies (SOCKS5) | Config files |
|------|-----|---------|----------------|-------------------|--------------|
| **Vercel** | ✅ | ✅ native | ✅ | ✅ | `api/piapi.js` (already set) |
| **Netlify** | ✅ | ✅ Functions | ✅ | ✅ | `netlify.toml`, `netlify/functions/piapi.js` |
| **Cloudflare Pages** | ✅ | ⚠️ requires flag | ❌ disabled | ⚠️ runtime-dependent | `wrangler.toml`, `functions/api/piapi.js` |
| **Replit / Render / Railway / Fly / Docker / VPS** | ✅ | ✅ Express | ✅ | ✅ | `server.js`, `.replit` |

---

## Vercel (zero config)

Already works. Push the repo and hit **Deploy**.

- `api/piapi.js` is auto-discovered.
- No env vars required.

---

## Netlify

1. Connect the repo in the Netlify dashboard.
2. Build settings are read from `netlify.toml`:
   - Build: `npm run build`
   - Publish: `dist`
   - Functions: `netlify/functions`
3. `/api/piapi` is redirected to the bundled function automatically.

No env vars required.

---

## Cloudflare Pages

1. Connect the repo in the Cloudflare dashboard.
2. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
3. **Required flag**: Settings → Functions → Compatibility flags → add
   **`nodejs_compat_v2`**. Without this, `formidable`, `undici`,
   `socks-proxy-agent`, and Node built-ins (`https`, `tls`, `net`) will
   fail at runtime.
4. The adapter in `functions/api/piapi.js` bridges the Workers `Request`
   to the existing Node handler.

**Known limitations on Cloudflare Pages/Workers:**

- **HTTP proxy is disabled.** `undici.ProxyAgent` depends on `node:sqlite`,
  which Workers does not provide. The backend detects the Workers runtime
  and returns a clear error for any HTTP proxy request. Use SOCKS5 instead,
  or deploy the backend to Vercel / Netlify / Node for full HTTP proxy
  support.
- **SOCKS5** support depends on how complete the Workers `net` module is
  on your deploy date. It generally works with `nodejs_compat_v2`. If it
  fails, deploy elsewhere.

---

## Replit / Render / Railway / Fly.io / Docker / any Node VPS

Use the universal `server.js`:

```bash
npm ci
npm run build
npm start          # PORT=3000 by default
```

- `.replit` is pre-configured for Replit (auto-build + autoscale deploy).
- Any host that supports `npm start` will work. Render/Railway/Fly all
  auto-detect the `start` script.
- Docker: mount the repo, run `npm ci && npm run build && npm start`.

---

## Local development

```bash
npm install
npm run dev         # Vite dev server + in-process /api/piapi bridge
```

The dev server proxies `/api/piapi` to the local handler via a middleware
plugin in `vite.config.js` — no separate backend process needed.

---

## Environment variables

| Name | Used at | Purpose |
|------|---------|---------|
| `VITE_API_BASE` | build time | Override same-origin `/api/piapi` (only needed if SPA and backend live on different origins) |
| `BASE_PATH` | build time | Asset base path; default `/`, set to `/subpath/` for subpath-hosted deploys |
| `PORT` | runtime (server.js) | TCP port, default `3000` |
| `HOST` | runtime (server.js) | Bind address, default `0.0.0.0` |

All API keys (PiAPI, Webshare) are entered in the UI and stored in
`localStorage` — none of them are build-time secrets.
