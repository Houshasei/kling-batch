# Deployment Guide

Kling Batch works on every major host. The backend handler in `api/piapi.js`
is a **Node.js serverless function** — so any host that runs Node works
out of the box. Static-only hosts (GitHub Pages) need an external backend.

## Quick compatibility matrix

| Host | SPA | Backend | Proxies (HTTP) | Proxies (SOCKS5) | Config files |
|------|-----|---------|----------------|-------------------|--------------|
| **Vercel** | ✅ | ✅ native | ✅ | ✅ | `api/piapi.js` (already set) |
| **Netlify** | ✅ | ✅ Functions | ✅ | ✅ | `netlify.toml`, `netlify/functions/piapi.js` |
| **Cloudflare Pages** | ✅ | ⚠️ requires flag | ✅ | ⚠️ runtime-dependent | `wrangler.toml`, `functions/api/piapi.js` |
| **Replit / Render / Railway / Fly / Docker / VPS** | ✅ | ✅ Express | ✅ | ✅ | `server.js`, `.replit` |
| **GitHub Pages** | ✅ | ❌ static only | n/a (external) | n/a (external) | `.github/workflows/gh-pages.yml` |

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

**Known limitation:** SOCKS5 proxy support depends on how complete the
Workers `net` module is on the date of deploy. If SOCKS5 fails on
Cloudflare, switch the UI proxy protocol to **HTTP** (still works), or
deploy elsewhere.

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

## GitHub Pages (static SPA + external backend)

GitHub Pages cannot run Node, so the SPA must call a backend deployed
elsewhere (Vercel / Netlify / Replit / etc.).

### Setup

1. Deploy the backend first. Easiest: 1-click Vercel.
2. In your GitHub repo → **Settings → Secrets and variables → Actions**
   add a secret named `VITE_API_BASE` with the root URL of your backend,
   e.g. `https://my-kling.vercel.app` (no trailing slash, no `/api`).
3. Enable **Pages** in repo settings (source: GitHub Actions).
4. Push to `main`. The workflow at `.github/workflows/gh-pages.yml` will:
   - Build with `BASE_PATH=/<repo-name>/` so asset URLs resolve.
   - Inject `VITE_API_BASE` into the build so fetches hit your backend.
   - Publish `dist/` to Pages.

### Backend CORS note

If the SPA is on `*.github.io` and the backend is on `*.vercel.app`,
you may need to allow cross-origin requests. The current backend does
not set CORS headers. Add this to `api/piapi.js` if you hit CORS errors:

```js
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Headers', 'content-type');
if (req.method === 'OPTIONS') { res.status(204).end(); return; }
```

(Place this at the top of the `handler` function.)

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
| `VITE_API_BASE` | build time | Override same-origin `/api/piapi` (only needed for GitHub Pages) |
| `BASE_PATH` | build time | Asset base path; default `/`, set to `/repo-name/` for GH Pages |
| `PORT` | runtime (server.js) | TCP port, default `3000` |
| `HOST` | runtime (server.js) | Bind address, default `0.0.0.0` |

All API keys (PiAPI, Webshare) are entered in the UI and stored in
`localStorage` — none of them are build-time secrets.
