/**
 * Cloudflare-native HTTP/1.1 client with SOCKS5 + HTTP CONNECT proxy support.
 *
 * Why this exists: on Cloudflare Workers, the Node-compat shim (`unenv`) does
 * NOT implement `http.request` / `https.request`. That means `undici` (HTTP
 * proxy) and `socks-proxy-agent` (SOCKS5) both fail at runtime. But Workers
 * DO expose raw TCP sockets via `cloudflare:sockets`, which is enough to
 * speak both proxy protocols by hand and then send plain HTTP/1.1 through
 * the tunnel. That's exactly what this module does.
 *
 * Only imported by `functions/api/piapi.js` so the `cloudflare:sockets`
 * module never appears in the Vercel / Netlify / Node bundles.
 */
import { connect } from 'cloudflare:sockets';

const CRLF = new Uint8Array([0x0d, 0x0a]);
const CRLFCRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const TE = new TextEncoder();
const TD = new TextDecoder();

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function indexOfSubarray(hay, needle) {
  const n = needle.length;
  if (n === 0) return 0;
  const last = hay.length - n;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Buffered stream reader for the raw socket `readable`. Gives us readN,
 * readUntil(delim) and readAll primitives that the Web Streams API doesn't
 * provide out of the box.
 */
class SocketReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.buf = new Uint8Array(0);
    this.done = false;
  }
  async _pull() {
    if (this.done) return false;
    const { value, done } = await this.reader.read();
    if (done) { this.done = true; return false; }
    this.buf = concatBytes([this.buf, value]);
    return true;
  }
  async readN(n) {
    while (this.buf.length < n) {
      const more = await this._pull();
      if (!more) throw new Error(`socket closed: wanted ${n} bytes, have ${this.buf.length}`);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async readUntil(delim) {
    while (true) {
      const idx = indexOfSubarray(this.buf, delim);
      if (idx >= 0) {
        const out = this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + delim.length);
        return out;
      }
      const more = await this._pull();
      if (!more) throw new Error('socket closed before delimiter');
    }
  }
  async readAll() {
    const parts = [this.buf];
    this.buf = new Uint8Array(0);
    while (!this.done) {
      const { value, done } = await this.reader.read();
      if (done) { this.done = true; break; }
      parts.push(value);
    }
    return concatBytes(parts);
  }
  release() { try { this.reader.releaseLock(); } catch (_) {} }
}

async function writeAll(writable, bytes) {
  const writer = writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    try { writer.releaseLock(); } catch (_) {}
  }
}

// =============================================================================
// Proxy URL parsing
// =============================================================================

/**
 * Parse a proxy URL into a config object usable by cfFetch.
 * Returns null if the URL is not a supported proxy scheme.
 */
export function parseProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  const u = new URL(proxyUrl);
  let kind;
  if (u.protocol === 'http:' || u.protocol === 'https:') kind = 'http';
  else if (u.protocol === 'socks5:' || u.protocol === 'socks:' || u.protocol === 'socks5h:') kind = 'socks5';
  else return null;
  return {
    kind,
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : (kind === 'socks5' ? 1080 : 80)),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    proxyTls: u.protocol === 'https:',
  };
}

// =============================================================================
// SOCKS5 handshake (RFC 1928 + RFC 1929)
// =============================================================================

async function doSocks5Handshake(sock, proxy, targetHost, targetPort) {
  const reader = new SocketReader(sock.readable);
  try {
    const useAuth = Boolean(proxy.username);
    // Greeting
    await writeAll(sock.writable, new Uint8Array([0x05, 0x01, useAuth ? 0x02 : 0x00]));
    const greet = await reader.readN(2);
    if (greet[0] !== 0x05) throw new Error(`SOCKS5: bad version 0x${greet[0].toString(16)}`);
    if (greet[1] === 0xff) throw new Error('SOCKS5: server rejected auth methods');
    if (useAuth && greet[1] !== 0x02) throw new Error(`SOCKS5: server chose method 0x${greet[1].toString(16)}, expected 0x02 (user/pass)`);
    if (!useAuth && greet[1] !== 0x00) throw new Error(`SOCKS5: server requires auth but no credentials given (method 0x${greet[1].toString(16)})`);

    // Auth (if required)
    if (useAuth) {
      const user = TE.encode(proxy.username || '');
      const pass = TE.encode(proxy.password || '');
      if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5: auth creds too long');
      const frame = new Uint8Array(3 + user.length + pass.length);
      let p = 0;
      frame[p++] = 0x01;            // auth subnegotiation version
      frame[p++] = user.length;
      frame.set(user, p); p += user.length;
      frame[p++] = pass.length;
      frame.set(pass, p);
      await writeAll(sock.writable, frame);
      const authResp = await reader.readN(2);
      if (authResp[1] !== 0x00) throw new Error(`SOCKS5: auth failed (status 0x${authResp[1].toString(16)})`);
    }

    // CONNECT request
    const hostBytes = TE.encode(targetHost);
    if (hostBytes.length > 255) throw new Error('SOCKS5: target hostname too long');
    const req = new Uint8Array(7 + hostBytes.length);
    let p = 0;
    req[p++] = 0x05; req[p++] = 0x01; req[p++] = 0x00; // VER, CMD=CONNECT, RSV
    req[p++] = 0x03;                                   // ATYP=DOMAINNAME
    req[p++] = hostBytes.length;
    req.set(hostBytes, p); p += hostBytes.length;
    req[p++] = (targetPort >> 8) & 0xff;
    req[p++] = targetPort & 0xff;
    await writeAll(sock.writable, req);

    // Reply
    const hdr = await reader.readN(4);
    if (hdr[1] !== 0x00) {
      const codes = {
        0x01: 'general failure', 0x02: 'connection not allowed by ruleset',
        0x03: 'network unreachable', 0x04: 'host unreachable',
        0x05: 'connection refused', 0x06: 'TTL expired',
        0x07: 'command not supported', 0x08: 'address type not supported',
      };
      throw new Error(`SOCKS5: CONNECT failed — ${codes[hdr[1]] || `0x${hdr[1].toString(16)}`}`);
    }
    const atyp = hdr[3];
    let skip;
    if (atyp === 0x01) skip = 4;
    else if (atyp === 0x04) skip = 16;
    else if (atyp === 0x03) skip = (await reader.readN(1))[0];
    else throw new Error(`SOCKS5: unknown ATYP 0x${atyp.toString(16)}`);
    await reader.readN(skip + 2); // skip bound addr + port

    // Any buffered bytes left? Shouldn't be, but surface the error if so —
    // we need to release the lock cleanly before startTls can wrap the socket.
    if (reader.buf.length > 0) throw new Error(`SOCKS5: ${reader.buf.length} unexpected bytes after handshake`);
  } finally {
    reader.release();
  }
}

// =============================================================================
// HTTP CONNECT handshake (RFC 7231 §4.3.6)
// =============================================================================

async function doHttpConnectHandshake(sock, proxy, targetHost, targetPort) {
  const reader = new SocketReader(sock.readable);
  try {
    let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`;
    req += `Host: ${targetHost}:${targetPort}\r\n`;
    if (proxy.username) {
      const creds = btoa(`${proxy.username}:${proxy.password || ''}`);
      req += `Proxy-Authorization: Basic ${creds}\r\n`;
    }
    req += `Proxy-Connection: keep-alive\r\n\r\n`;
    await writeAll(sock.writable, TE.encode(req));

    const head = await reader.readUntil(CRLFCRLF);
    const text = TD.decode(head);
    const firstLine = text.split('\r\n', 1)[0];
    const m = firstLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
    if (!m) throw new Error(`HTTP CONNECT: bad status line "${firstLine}"`);
    const status = parseInt(m[1], 10);
    if (status !== 200) throw new Error(`HTTP CONNECT: proxy returned ${firstLine}`);

    if (reader.buf.length > 0) throw new Error(`HTTP CONNECT: ${reader.buf.length} unexpected bytes after handshake`);
  } finally {
    reader.release();
  }
}

// =============================================================================
// Tunnel opener
// =============================================================================

async function openTunnel(proxy, targetHost, targetPort, { willStartTls = false } = {}) {
  // Cloudflare's `connect()` requires `secureTransport: 'starttls'` at
  // connect-time if the caller plans to invoke `socket.startTls()` later.
  // Without it, startTls throws:
  //   "The `secureTransport` socket option must be set to 'starttls'
  //    for startTls to be used."
  const opts = willStartTls ? { secureTransport: 'starttls' } : {};

  if (!proxy) return connect({ hostname: targetHost, port: targetPort, ...opts });

  // HTTPS proxies would need TLS before the CONNECT handshake — rare for
  // HTTP proxies, non-existent for SOCKS5. We don't support proxyTls=true
  // yet; throw cleanly instead of silently doing the wrong thing.
  if (proxy.proxyTls) throw new Error('HTTPS-to-proxy (proxy URL with https://) is not supported on Cloudflare yet');

  const sock = connect({ hostname: proxy.host, port: proxy.port, ...opts });
  if (proxy.kind === 'socks5') {
    await doSocks5Handshake(sock, proxy, targetHost, targetPort);
  } else if (proxy.kind === 'http') {
    await doHttpConnectHandshake(sock, proxy, targetHost, targetPort);
  } else {
    throw new Error(`unknown proxy kind: ${proxy.kind}`);
  }
  return sock;
}

// =============================================================================
// HTTP/1.1 request + response
// =============================================================================

async function writeRequest(socket, { method, pathAndQuery, hostHeader, headers, body }) {
  const final = { Host: hostHeader, Connection: 'close', ...headers };
  let bodyBytes = null;
  if (body != null) {
    if (body instanceof Uint8Array) bodyBytes = body;
    else if (typeof body === 'string') bodyBytes = TE.encode(body);
    else if (typeof Buffer !== 'undefined' && body instanceof Buffer) bodyBytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    else throw new Error(`cfFetch: unsupported body type ${typeof body}`);
    if (final['Content-Length'] == null && final['content-length'] == null) {
      final['Content-Length'] = String(bodyBytes.length);
    }
  }

  let text = `${method} ${pathAndQuery} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(final)) {
    if (v == null) continue;
    text += `${k}: ${v}\r\n`;
  }
  text += '\r\n';
  const head = TE.encode(text);

  const writer = socket.writable.getWriter();
  try {
    await writer.write(head);
    if (bodyBytes) await writer.write(bodyBytes);
    // Intentionally do NOT close the writer — half-closing confuses some
    // servers while they're still writing the response. `Connection: close`
    // plus an accurate Content-Length is enough for the server to know the
    // request is complete.
  } finally {
    try { writer.releaseLock(); } catch (_) {}
  }
}

async function readChunkedBody(reader) {
  const parts = [];
  while (true) {
    const sizeLine = TD.decode(await reader.readUntil(CRLF)).split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error(`cfFetch: bad chunk size "${sizeLine}"`);
    if (size === 0) {
      // Trailer section (usually empty) terminated by blank line.
      // We've already consumed the CRLF after "0", so the next read consumes
      // any trailer headers up to CRLFCRLF-equivalent; simplest correct move:
      // just read until CRLF repeatedly until we see an empty line.
      while (true) {
        const line = await reader.readUntil(CRLF);
        if (line.length === 0) break;
      }
      break;
    }
    parts.push(await reader.readN(size));
    await reader.readN(2); // CRLF terminator for the chunk
  }
  return concatBytes(parts);
}

async function readResponse(socket) {
  const reader = new SocketReader(socket.readable);
  const headBytes = await reader.readUntil(CRLFCRLF);
  const headText = TD.decode(headBytes);
  const lines = headText.split('\r\n');
  const statusLine = lines[0] || '';
  const m = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)(?:\s+(.*))?$/);
  if (!m) throw new Error(`cfFetch: bad status line "${statusLine}"`);
  const status = parseInt(m[1], 10);
  const statusText = m[2] || '';

  const headers = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    const prev = headers.get(k);
    headers.set(k, prev ? `${prev}, ${v}` : v);
  }

  let body;
  const te = (headers.get('transfer-encoding') || '').toLowerCase();
  const cl = headers.get('content-length');
  const isHead = false; // we don't issue HEAD requests; keep simple
  if (status === 204 || status === 304 || isHead) {
    body = new Uint8Array(0);
  } else if (te.includes('chunked')) {
    body = await readChunkedBody(reader);
  } else if (cl != null) {
    const n = parseInt(cl, 10);
    body = Number.isFinite(n) && n > 0 ? await reader.readN(n) : new Uint8Array(0);
  } else {
    body = await reader.readAll();
  }
  reader.release();

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: (k) => headers.get(String(k).toLowerCase()),
      has: (k) => headers.has(String(k).toLowerCase()),
      entries: () => headers.entries(),
    },
    async text() { return TD.decode(body); },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
    async bytes() { return body; },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Minimal fetch-shaped HTTP/1.1 client on top of `cloudflare:sockets`.
 *
 *   const r = await cfFetch('https://example.com/api', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ foo: 1 }),
 *     proxy: { kind: 'socks5', host, port, username, password },
 *   });
 *   if (!r.ok) throw new Error(r.status);
 *   const text = await r.text();
 */
export async function cfFetch(url, { method = 'GET', headers = {}, body = null, proxy = null } = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const targetPort = Number(u.port) || (isHttps ? 443 : 80);
  const targetHost = u.hostname;
  const pathAndQuery = (u.pathname || '/') + (u.search || '');
  const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;

  const rawSocket = await openTunnel(proxy, targetHost, targetPort, { willStartTls: isHttps });
  const socket = isHttps
    ? rawSocket.startTls({ expectedServerHostname: targetHost })
    : rawSocket;

  await writeRequest(socket, { method, pathAndQuery, hostHeader, headers, body });
  const resp = await readResponse(socket);
  try { await socket.close(); } catch (_) {}
  return resp;
}
