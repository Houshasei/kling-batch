# Deployment Guide

Kling Batch works on every major Node-capable host. The backend handler in
`api/piapi.js` is a **Node.js serverless function**, so any host that runs
Node works out of the box.

## Quick compatibility matrix

| Host | SPA | Backend | Proxy (SOCKS5 only) | Config files |
|------|-----|---------|---------------------|--------------|
| **Vercel** | ✅ | ✅ native | ✅ `socks-proxy-agent` | `api/piapi.js` (already set) |
| **Netlify** | ✅ | ✅ Functions | ✅ `socks-proxy-agent` | `netlify.toml`, `netlify/functions/piapi.js` |
| **Cloudflare Pages** | ✅ | ⚠️ requires flag | ✅ custom `cfFetch` client | `wrangler.toml`, `functions/api/piapi.js`, `functions/lib/cf-http.js` |
| **Replit / Render / Railway / Fly / Docker / VPS** | ✅ | ✅ Express | ✅ `socks-proxy-agent` | `server.js`, `.replit` |

> **HTTP/HTTPS proxies are not supported on any deployment target.**
> Configure your Webshare plan (or other proxy provider) to emit SOCKS5
> proxies on port 1080. The UI only accepts `socks5://` URLs.

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

**Notes on Cloudflare Pages/Workers:**

- **Proxies work via a custom HTTP client** (`functions/lib/cf-http.js`).
  Because Workers' Node-compat shim (`unenv`) does not implement
  `http.request` / `https.request`, we can't use `undici` or
  `socks-proxy-agent`. Instead, on Cloudflare we open a raw TCP socket
  via `cloudflare:sockets`, hand-roll the SOCKS5 or HTTP CONNECT
  handshake, upgrade to TLS with `startTls()`, and speak HTTP/1.1
  directly. Vercel / Netlify / Node keep using `undici` and
  `socks-proxy-agent` unchanged.
- **CPU time on free tier.** Workers Free plan caps CPU at 10 ms per
  invocation, which will time out on large proxied uploads and Kling
  polling under load. **Workers Paid ($5/mo)** raises this to 30 s —
  comfortably enough for this app's workload. Direct (no-proxy) calls
  are usually fine on free tier because they're I/O-bound.
- **Egress is unlimited** on Cloudflare — the main reason to deploy here
  if the backend's `download_proxy` endpoint burns bandwidth on other
  hosts.

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
