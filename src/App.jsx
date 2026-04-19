import { useCallback, useEffect, useRef, useState } from "react";
import { Analytics } from "@vercel/analytics/react";
import JSZip from "jszip";

// =======================================================================
// Constants / theme
// =======================================================================

const POLL_INTERVAL = 8000;
const MAX_AUTO_RETRIES = 5;
const UPLOAD_PROPAGATION_MS = 2000;
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const VERCEL_HOBBY_LIMIT = 4 * 1024 * 1024;
const MAX_LONG_EDGE_PX = 1536;
const NORMALIZE_JPG_QUALITY = 0.92;
const RETRY_JPG_QUALITIES = [0.88, 0.85, 0.82, 0.79, 0.76];
const LOG_BUFFER = 300;
const STORAGE_API_KEY = "kling_batch_api_key";
const STORAGE_UPLOAD_HOST = "kling_batch_upload_host";
const STORAGE_USE_PROXY = "kling_batch_use_proxy";
const STORAGE_WEBSHARE_KEY = "kling_batch_webshare_key";
const STORAGE_PROXY_PROTOCOL = "kling_batch_proxy_protocol";
const MAX_PROXY_REROLLS = 5;
const PROXY_PROTOCOLS = ["http", "socks5"];

const font = `'DM Sans', sans-serif`;
const mono = `'JetBrains Mono', 'Fira Code', monospace`;

const c = {
  bg: "#0c0c0f",
  surface: "#16161a",
  border: "#2a2a32",
  text: "#e8e8ed",
  muted: "#8888a0",
  hint: "#55556a",
  accent: "#6c5ce7",
  success: "#00b894",
  warn: "#fdcb6e",
  error: "#e17055",
  tag: "#2d2d3a",
};

// Host registry — add a new host: one entry + one server-side uploader.
const HOST_OPTIONS = [
  { id: "litterbox", label: "Litterbox \u00B7 1h", maxConcurrent: 4 },
  { id: "tmpfile", label: "tmpfile.link", maxConcurrent: 8 },
];
const DEFAULT_HOST = "litterbox";

const VIDEO_EXTS = ["mp4", "mov"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp"];

// =======================================================================
// Small utilities
// =======================================================================

function fileExt(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "";
}

function isAllowedFile(file, kind) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  const ext = fileExt(file.name);
  if (kind === "video") return type.startsWith("video/") || VIDEO_EXTS.includes(ext);
  if (kind === "image") return type.startsWith("image/") || IMAGE_EXTS.includes(ext);
  return false;
}

function safeBase(name) {
  return (
    String(name || "video")
      .replace(/\.\w+$/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "video"
  );
}

function rand4() {
  return Math.random().toString(36).slice(2, 6);
}

function fileToPreview(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(file);
  });
}

function truncate(str, max = 200) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

// =======================================================================
// Concurrency limiter: one per host
// =======================================================================

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length > 0) {
      const { fn, resolve, reject, onStart } = queue.shift();
      active++;
      if (onStart) onStart();
      Promise.resolve()
        .then(fn)
        .then((v) => { active--; resolve(v); pump(); })
        .catch((e) => { active--; reject(e); pump(); });
    }
  };
  return {
    run(fn, onStart) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject, onStart });
        pump();
      });
    },
    pending() { return queue.length; },
    active() { return active; },
  };
}

const limiters = Object.fromEntries(
  HOST_OPTIONS.map((h) => [h.id, createLimiter(h.maxConcurrent)])
);

// =======================================================================
// Proxy pool — strictly single-use per session
// =======================================================================

function createProxyPool(proxies) {
  const shuffled = [...proxies];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const burned = new Set();
  return {
    take() { return shuffled.shift() || null; },
    burn(p) { if (p) burned.add(p.id); },
    remaining() { return shuffled.length; },
    total() { return proxies.length; },
    burnedCount() { return burned.size; },
    replace(newProxies) {
      const extras = newProxies.filter((p) => !burned.has(p.id));
      for (let i = extras.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [extras[i], extras[j]] = [extras[j], extras[i]];
      }
      shuffled.push(...extras);
    },
  };
}

// =======================================================================
// Ratio-preserving image normalization + retry re-encoding (9:16 safe)
// =======================================================================

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Canvas encode failed")), mime, quality);
  });
}

function drawOpaque(img, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

/**
 * Attempt-0 pre-flight. Ratio-preserving; no cropping ever.
 * Runs only if source is PNG, exceeds MAX_LONG_EDGE_PX, or has a non-image/jpeg type.
 * Returns { file, changed, detail }.
 */
async function normalizeForKling(file) {
  const type = String(file.type || "").toLowerCase();
  const isJpg = type === "image/jpeg" || type === "image/jpg";
  const img = await loadImage(file);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const longEdge = Math.max(srcW, srcH);

  const needsDownscale = longEdge > MAX_LONG_EDGE_PX;
  const needsReencode = !isJpg; // PNG/WebP/etc. → JPG to strip alpha/EXIF and match Kling's expected format

  if (!needsDownscale && !needsReencode) {
    return { file, changed: false, detail: `passthrough ${srcW}x${srcH} jpg` };
  }

  let outW = srcW;
  let outH = srcH;
  if (needsDownscale) {
    const scale = MAX_LONG_EDGE_PX / longEdge;
    outW = Math.round(srcW * scale);
    outH = Math.round(srcH * scale);
  }

  const { canvas } = drawOpaque(img, outW, outH);
  const blob = await canvasToBlob(canvas, "image/jpeg", NORMALIZE_JPG_QUALITY);
  const outName = `${safeBase(file.name)}-norm.jpg`;
  const newFile = new File([blob], outName, { type: "image/jpeg", lastModified: Date.now() });
  const detail = `${type || "unknown"} ${srcW}x${srcH} → jpg ${outW}x${outH} (${formatBytes(file.size)} → ${formatBytes(newFile.size)})`;
  return { file: newFile, changed: true, detail };
}

/**
 * Retry re-encoding that preserves pixel dimensions bit-exactly.
 * Varies JPG quality per attempt and flips one imperceptible pixel to defeat
 * any content-hash / perceptual-hash dedupe on the Kling side.
 * @param {File} file - the image that was already uploaded (post-normalization on attempt 0)
 * @param {number} attempt - 1-indexed retry attempt
 * @returns {Promise<{file: File, detail: string}>}
 */
async function reencodeForRetry(file, attempt) {
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const { canvas, ctx } = drawOpaque(img, w, h);

  // Flip one pixel imperceptibly. Position varies per attempt so retries never collide.
  const corners = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
    [Math.floor(w / 2), Math.floor(h / 2)],
  ];
  const [px, py] = corners[(attempt - 1) % corners.length];
  const pixel = ctx.getImageData(px, py, 1, 1);
  pixel.data[0] = (pixel.data[0] + 1) % 256; // ±1 in R channel
  ctx.putImageData(pixel, px, py);

  const q = RETRY_JPG_QUALITIES[(attempt - 1) % RETRY_JPG_QUALITIES.length];
  const blob = await canvasToBlob(canvas, "image/jpeg", q);
  const outName = `${safeBase(file.name)}-r${attempt}-${rand4()}.jpg`;
  const newFile = new File([blob], outName, { type: "image/jpeg", lastModified: Date.now() });
  const detail = `jpg q=${q}, dims preserved ${w}x${h}, pixel=${px},${py}, ${formatBytes(file.size)} → ${formatBytes(newFile.size)}`;
  return { file: newFile, detail };
}

// =======================================================================
// Components
// =======================================================================

function StatusBadge({ status, retries }) {
  const map = {
    pending: { color: c.muted, label: "Pending" },
    uploading: { color: c.warn, label: "Uploading" },
    processing: { color: c.accent, label: "Processing" },
    completed: { color: c.success, label: "Done" },
    failed: { color: c.error, label: "Failed" },
    retrying: { color: c.warn, label: `Auto-retry ${retries}/${MAX_AUTO_RETRIES}` },
  };
  const s = map[status] || map.pending;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontFamily: mono, textTransform: "uppercase", letterSpacing: "0.07em", color: s.color }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.color, animation: ["processing", "uploading", "retrying"].includes(status) ? "pulse 1.5s infinite" : "none" }} />
      {s.label}
    </span>
  );
}

function ZipButton({ count, progress, onClick }) {
  const busy = progress.phase === "downloading" || progress.phase === "zipping";
  let label = `Download ZIP (${count})`;
  if (progress.phase === "downloading") label = `Downloading ${progress.done}/${progress.total} (${progress.percent}%)`;
  else if (progress.phase === "zipping") label = `Zipping ${progress.percent}%`;
  else if (progress.phase === "done") label = `ZIP ready`;
  const percent = progress.percent || 0;

  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        position: "relative", padding: "6px 12px", borderRadius: 5,
        background: busy ? c.tag : c.success, border: "none", color: "#fff",
        fontSize: 11, fontWeight: 600, cursor: busy ? "default" : "pointer",
        display: "flex", alignItems: "center", gap: 6, overflow: "hidden", minWidth: 160,
      }}
    >
      {busy && (
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${percent}%`, background: c.accent + "55", transition: "width 0.2s ease", zIndex: 0 }} />
      )}
      <span style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 6 }}>
        {busy && <span style={{ width: 10, height: 10, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />}
        {label}
      </span>
    </button>
  );
}

// =======================================================================
// Main
// =======================================================================

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_API_KEY) || "");
  const [connected, setConnected] = useState(() => Boolean(localStorage.getItem(STORAGE_API_KEY)));
  const [uploadHost, setUploadHost] = useState(() => {
    const saved = localStorage.getItem(STORAGE_UPLOAD_HOST);
    return HOST_OPTIONS.some((h) => h.id === saved) ? saved : DEFAULT_HOST;
  });

  const [useProxy, setUseProxy] = useState(() => localStorage.getItem(STORAGE_USE_PROXY) === "true");
  const [webshareKey, setWebshareKey] = useState(() => localStorage.getItem(STORAGE_WEBSHARE_KEY) || "");
  const [webshareInput, setWebshareInput] = useState("");
  const [proxyProtocol, setProxyProtocol] = useState(() => {
    const saved = localStorage.getItem(STORAGE_PROXY_PROTOCOL);
    return PROXY_PROTOCOLS.includes(saved) ? saved : "socks5";
  });
  const [proxyCount, setProxyCount] = useState(0);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyError, setProxyError] = useState("");
  const proxyPoolRef = useRef(null);

  const [refVideoFileName, setRefVideoFileName] = useState("");
  const [refVideoError, setRefVideoError] = useState("");
  const [videoDuration, setVideoDuration] = useState(10);
  const [isVideoDragOver, setIsVideoDragOver] = useState(false);
  const [isImageDragOver, setIsImageDragOver] = useState(false);
  const [images, setImages] = useState([]);
  const [mode, setMode] = useState("std");
  const [orientation, setOrientation] = useState("image");
  const [keepSound, setKeepSound] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [running, setRunning] = useState(false);
  const [batchDone, setBatchDone] = useState(false);
  const [logs, setLogs] = useState([]);
  const [zipProgress, setZipProgress] = useState({ phase: "idle", done: 0, total: 0, percent: 0 });

  const imgRef = useRef();
  const replaceImgRefs = useRef({});
  const jobsRef = useRef([]);
  const pollRef = useRef(null);
  const refVideoUrlRef = useRef("");
  const refVideoFileRef = useRef(null);
  const refVideoHostRef = useRef(DEFAULT_HOST);
  const logsEndRef = useRef(null);
  const videoDragCounter = useRef(0);
  const imageDragCounter = useRef(0);

  const rate = mode === "std" ? 0.065 : 0.104;
  const perVideo = rate * videoDuration;
  const batchEst = perVideo * images.length;

  const log = useCallback((type, message) => {
    setLogs((prev) => {
      const next = [...prev, {
        id: Date.now() + Math.random(),
        ts: new Date().toLocaleTimeString(),
        type,
        message,
      }];
      return next.length > LOG_BUFFER ? next.slice(next.length - LOG_BUFFER) : next;
    });
  }, []);

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  useEffect(() => { localStorage.setItem(STORAGE_API_KEY, apiKey || ""); }, [apiKey]);
  useEffect(() => { localStorage.setItem(STORAGE_UPLOAD_HOST, uploadHost); }, [uploadHost]);
  useEffect(() => { localStorage.setItem(STORAGE_USE_PROXY, useProxy ? "true" : "false"); }, [useProxy]);
  useEffect(() => { localStorage.setItem(STORAGE_WEBSHARE_KEY, webshareKey || ""); }, [webshareKey]);
  useEffect(() => { localStorage.setItem(STORAGE_PROXY_PROTOCOL, proxyProtocol); }, [proxyProtocol]);

  // Global drop guard
  useEffect(() => {
    const prevent = (e) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // =====================================================================
  // Upload (proxy → /api/piapi)
  // =====================================================================

  function copyLogs() {
    const text = logs.map((l) => `[${l.ts}] [${l.type}] ${l.message}`).join("\n");
    navigator.clipboard?.writeText(text).then(
      () => log("success", "Logs copied"),
      (err) => log("error", `Copy failed: ${err.message}`)
    );
  }

  async function proxyJson(body) {
    const action = body?.action;
    const needsApiKey = action === "create" || action === "poll";
    const payload = needsApiKey ? { apiKey, ...body } : body;
    let r;
    try {
      r = await fetch("/api/piapi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const e = new Error(`Network error (${action}): ${err.message}`);
      e.proxyFailed = Boolean(body?.proxyUrl);
      throw e;
    }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    if (!r.ok) {
      const e = new Error(`${action} HTTP ${r.status}: ${truncate(json?.error || text, 200)}`);
      e.status = r.status;
      e.proxyFailed = Boolean(json?.proxyFailed);
      throw e;
    }
    if (json && json.error) {
      const e = new Error(`${action}: ${truncate(json.error, 200)}`);
      e.proxyFailed = Boolean(json?.proxyFailed);
      throw e;
    }
    return json ?? {};
  }

  function extractUploadUrl(resp) {
    return (
      resp?.data?.downloadLinkEncoded ||
      resp?.data?.downloadLink ||
      ""
    );
  }

  async function uploadViaProxy(file, host, proxyUrl) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("action", "upload_file");
    fd.append("host", host);
    if (proxyUrl) fd.append("proxyUrl", proxyUrl);

    let r;
    try {
      r = await fetch("/api/piapi", { method: "POST", body: fd });
    } catch (err) {
      const e = new Error(`Network error during upload: ${err.message}`);
      e.proxyFailed = Boolean(proxyUrl);
      throw e;
    }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}

    if (!r.ok) {
      const msg = json?.error || truncate(text, 200) || `HTTP ${r.status}`;
      const e = new Error(`Upload HTTP ${r.status}: ${msg}`);
      e.status = r.status;
      e.proxyFailed = Boolean(json?.proxyFailed);
      throw e;
    }

    const url = extractUploadUrl(json || {});
    if (!url) throw new Error("Upload returned no URL");
    return { url, finalHost: json?.data?.uploadedTo || host };
  }

  async function loadProxies(key, { silent = false, protocol } = {}) {
    const k = key || webshareKey;
    if (!k) return null;
    const proto = protocol || proxyProtocol;
    setProxyLoading(true);
    setProxyError("");
    try {
      const d = await proxyJson({ action: "list_proxies", webshareKey: k, protocol: proto });
      const list = Array.isArray(d?.proxies) ? d.proxies : [];
      if (list.length === 0) throw new Error("Webshare returned 0 proxies");
      proxyPoolRef.current = createProxyPool(list);
      setProxyCount(list.length);
      if (!silent) log("success", `Webshare: loaded ${list.length} proxies (${proto.toUpperCase()})`);
      return list.length;
    } catch (err) {
      setProxyError(err.message);
      if (!silent) log("error", `Webshare: ${err.message}`);
      return null;
    } finally {
      setProxyLoading(false);
    }
  }

  // Auto-load pool on mount if toggle is on and key is saved.
  useEffect(() => {
    if (useProxy && webshareKey && !proxyPoolRef.current) {
      loadProxies(webshareKey, { silent: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Take a proxy from the pool (refreshing from Webshare if exhausted).
  async function takeProxy(jl) {
    let pool = proxyPoolRef.current;
    if (!pool || pool.remaining() === 0) {
      log("warn", `${jl}Proxy pool exhausted — refreshing from Webshare…`);
      const n = await loadProxies(webshareKey, { silent: true });
      pool = proxyPoolRef.current;
      if (!n || !pool || pool.remaining() === 0) return null;
    }
    return pool.take();
  }

  async function uploadToHost(file, host, { jobLabel, job } = {}) {
    const chosenHost = host || uploadHost;
    const jl = jobLabel ? `[${jobLabel}] ` : "";

    // Proxy mode: single proxy per job — shared with Kling lifecycle if job is provided.
    if (useProxy && webshareKey) {
      let attempts = 0;
      let lastErr;
      while (attempts < MAX_PROXY_REROLLS) {
        // Reuse the job's existing proxy if already assigned (re-read from ref each loop).
        const freshJob = job ? jobsRef.current.find((j) => j.id === job.id) : null;
        let proxy = freshJob?.jobProxyUrl ? { id: freshJob.jobProxyId, url: freshJob.jobProxyUrl } : null;
        if (!proxy) {
          proxy = await takeProxy(jl);
          if (!proxy) {
            log("warn", `${jl}No proxies available — falling back to direct upload`);
            break;
          }
          if (job) updateJob(job.id, { jobProxyId: proxy.id, jobProxyUrl: proxy.url });
        }

        try {
          log("info", `${jl}Uploading via ${chosenHost} [proxy ${proxy.id}]: ${formatBytes(file.size)} — ${file.name}`);
          const { url, finalHost } = await uploadViaProxy(file, chosenHost, proxy.url);
          log("success", `${jl}Uploaded via ${finalHost} [proxy ${proxy.id}]: ${url}`);
          await new Promise((res) => setTimeout(res, UPLOAD_PROPAGATION_MS));
          return { url, host: finalHost };
        } catch (err) {
          attempts++;
          lastErr = err;
          if (err.proxyFailed) {
            proxyPoolRef.current?.burn(proxy);
            log("warn", `${jl}Proxy ${proxy.id} failed (${err.message}) — re-rolling (pool: ${proxyPoolRef.current?.remaining() ?? 0} left)`);
            if (job) updateJob(job.id, { jobProxyId: null, jobProxyUrl: null });
            continue;
          }
          // Non-proxy error: don't reroll.
          throw err;
        }
      }
      log("warn", `${jl}Proxy attempts exhausted${lastErr ? `: ${lastErr.message}` : ""} — trying direct`);
    }

    // Non-proxy (or fallback) path: limiter-based.
    const limiter = limiters[chosenHost];
    const pending = limiter.pending();
    if (pending > 0) log("info", `${jl}Queued (${pending} ahead) on ${chosenHost}`);

    return limiter.run(async () => {
      log("info", `${jl}Uploading to ${chosenHost} (${formatBytes(file.size)}) — ${file.name}`);
      const { url, finalHost } = await uploadViaProxy(file, chosenHost);
      log("success", `${jl}Uploaded via ${finalHost}: ${url}`);
      await new Promise((res) => setTimeout(res, UPLOAD_PROPAGATION_MS));
      return { url, host: finalHost };
    });
  }

  async function handleSaveWebshareKey() {
    const key = webshareInput.trim();
    if (!key) return;
    setProxyError("");
    const n = await loadProxies(key, { silent: false });
    if (n) {
      setWebshareKey(key);
      setWebshareInput("");
    }
  }

  function handleChangeWebshareKey() {
    setWebshareKey("");
    setProxyCount(0);
    setProxyError("");
    proxyPoolRef.current = null;
  }

  async function handleChangeProtocol(next) {
    if (!PROXY_PROTOCOLS.includes(next) || next === proxyProtocol) return;
    setProxyProtocol(next);
    proxyPoolRef.current = null;
    setProxyCount(0);
    if (useProxy && webshareKey) {
      await loadProxies(webshareKey, { silent: false, protocol: next });
    }
  }

  // =====================================================================
  // Kling task lifecycle
  // =====================================================================

  async function ensureJobProxy(jobId) {
    if (!(useProxy && webshareKey)) return null;
    const existing = jobsRef.current.find((j) => j.id === jobId);
    if (existing?.jobProxyUrl) return { id: existing.jobProxyId, url: existing.jobProxyUrl };
    const p = await takeProxy(`[Job ${jobId + 1}] `);
    if (!p) return null;
    updateJob(jobId, { jobProxyId: p.id, jobProxyUrl: p.url });
    return p;
  }

  async function klingCall(body, jobId) {
    let attempts = 0;
    let lastErr;
    while (attempts < MAX_PROXY_REROLLS + 1) {
      try {
        return await proxyJson(body);
      } catch (err) {
        if (!err.proxyFailed || !(useProxy && webshareKey)) throw err;
        const job = jobsRef.current.find((j) => j.id === jobId);
        if (job?.jobProxyId) {
          proxyPoolRef.current?.burn({ id: job.jobProxyId });
          log("warn", `[Job ${jobId + 1}] Kling proxy ${job.jobProxyId} failed (${err.message}) — re-rolling`);
        }
        updateJob(jobId, { jobProxyId: null, jobProxyUrl: null });
        const p = await takeProxy(`[Job ${jobId + 1}] `);
        if (!p) {
          log("warn", `[Job ${jobId + 1}] No proxy available — going direct`);
          body.proxyUrl = null;
        } else {
          updateJob(jobId, { jobProxyId: p.id, jobProxyUrl: p.url });
          body.proxyUrl = p.url;
        }
        attempts++;
        lastErr = err;
      }
    }
    throw lastErr || new Error("Kling call failed after proxy rerolls");
  }

  async function submitCreateTask(job, imageUrl, videoUrl) {
    const p = await ensureJobProxy(job.id);
    const proxyUrl = p?.url || null;
    if (p) log("info", `[Job ${job.id + 1}] Kling create via proxy ${p.id}`);
    const d = await klingCall({
      action: "create",
      proxyUrl,
      taskBody: {
        model: "kling",
        task_type: "motion_control",
        input: {
          image_url: imageUrl,
          video_url: videoUrl,
          motion_direction: orientation,
          keep_original_sound: keepSound,
          mode,
          version: "2.6",
        },
      },
    }, job.id);
    if (d?.data?.task_id) return d.data.task_id;
    const msg = d?.message || d?.error?.message || "Create task failed";
    throw new Error(msg);
  }

  async function checkJob(job, { firstPoll = false } = {}) {
    const p = await ensureJobProxy(job.id);
    const proxyUrl = p?.url || null;
    if (firstPoll && p) {
      log("info", `[Job ${job.id + 1}] Kling poll via proxy ${p.id} (sticky)`);
    }
    const d = await klingCall({ action: "poll", taskId: job.taskId, proxyUrl }, job.id);
    return d?.data;
  }

  function updateJob(id, patch) {
    jobsRef.current = jobsRef.current.map((j) => (j.id === id ? { ...j, ...patch } : j));
    setJobs([...jobsRef.current]);
  }

  function isContentFilterError(msg) {
    const s = String(msg || "").toLowerCase();
    return s.includes("content violation") || s.includes("nsfw") || s.includes("deleted the task") || s.includes("fetch task failed") || s.includes("404 not found");
  }

  function isImageDecodeFetchError(msg) {
    const s = String(msg || "").toLowerCase();
    return (
      s.includes("failed to decode input image") ||
      s.includes("decode input image") ||
      s.includes("invalid image") ||
      s.includes("fetch") ||
      s.includes("freeze point") ||
      s.includes("freezepoint")
    );
  }

  function isFreezePointError(msg) {
    const s = String(msg || "").toLowerCase();
    return s.includes("freeze point") || s.includes("freezepoint");
  }

  async function submitSingleJob(job, videoUrl, { forceReupload = false, attempt = 0, reason = null } = {}) {
    try {
      updateJob(job.id, { status: "uploading", error: null });
      if (!job.file || !(job.file instanceof File)) throw new Error("Invalid file");

      let imageUrl = job.imageUrl;
      const hostForJob = job.hostSnapshot || uploadHost;

      if (!imageUrl || forceReupload) {
        // Baseline = ratio-preserving normalized file on attempt 0; cache on the job so retries reuse it.
        let baseline = job.normalizedFile instanceof File ? job.normalizedFile : null;
        if (!baseline) {
          const { file: normFile, changed, detail } = await normalizeForKling(job.file);
          baseline = normFile;
          if (changed) log("info", `[Job ${job.id + 1}] Normalized: ${detail}`);
          updateJob(job.id, { normalizedFile: baseline });
        }

        let fileToSend = baseline;
        if (attempt > 0) {
          const { file: reencoded, detail } = await reencodeForRetry(baseline, attempt);
          const tag = reason === "freeze_point" ? "freeze-point retry" : `retry ${attempt}`;
          log("info", `[Job ${job.id + 1}] Re-encoded for ${tag}: ${detail}`);
          fileToSend = reencoded;
        }

        const currentJob = jobsRef.current.find((j) => j.id === job.id) || job;
        const { url, host } = await uploadToHost(fileToSend, hostForJob, { jobLabel: `Job ${job.id + 1}`, job: currentJob });
        imageUrl = url;
        updateJob(job.id, { imageUrl: url, uploadProviderUsed: host });
      }

      log("info", `[Job ${job.id + 1}] Submitting to Kling…`);
      const freshJob = jobsRef.current.find((j) => j.id === job.id) || job;
      const taskId = await submitCreateTask(freshJob, imageUrl, videoUrl);
      updateJob(job.id, { status: "processing", taskId, error: null, videoUrl: null });
      log("success", `[Job ${job.id + 1}] Task submitted: ${taskId}`);
      return true;
    } catch (err) {
      updateJob(job.id, { status: "failed", error: err.message });
      log("error", `[Job ${job.id + 1}] ${err.message}`);
      return false;
    }
  }

  async function autoRetry(job, videoUrl, { forceReupload = false, reason = null } = {}) {
    const retries = (job.retries || 0) + 1;
    if (retries > MAX_AUTO_RETRIES) {
      updateJob(job.id, { status: "failed", retries });
      return;
    }
    updateJob(job.id, { status: "retrying", retries, error: null });
    await new Promise((r) => setTimeout(r, 1800));
    if (forceReupload) updateJob(job.id, { imageUrl: null });
    const fresh = jobsRef.current.find((j) => j.id === job.id) || job;
    await submitSingleJob(fresh, videoUrl, { forceReupload, attempt: retries, reason });
  }

  // =====================================================================
  // Reference video upload
  // =====================================================================

  async function handleRefVideoFile(file) {
    if (!file) return;
    if (!isAllowedFile(file, "video")) {
      setRefVideoError("Unsupported file. Use MP4 or MOV.");
      log("error", `Rejected ref video (type=${file.type || "unknown"}, ext=${fileExt(file.name)})`);
      return;
    }
    if (file.size > MAX_VIDEO_SIZE) {
      setRefVideoError(`Video too large (${formatBytes(file.size)}). Max: ${MAX_VIDEO_SIZE / 1024 / 1024}MB`);
      log("error", `Video too large: ${file.name}`);
      return;
    }
    try {
      setRefVideoError("");
      const { url, host } = await uploadToHost(file, uploadHost, { jobLabel: "RefVideo" });
      refVideoUrlRef.current = url;
      refVideoFileRef.current = file;
      refVideoHostRef.current = uploadHost;
      setRefVideoFileName(file.name);

      try {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.src = URL.createObjectURL(file);
        v.onloadedmetadata = () => {
          if (v.duration && !Number.isNaN(v.duration)) setVideoDuration(Math.ceil(v.duration));
          URL.revokeObjectURL(v.src);
        };
      } catch (_) {}

      log("success", `Reference video ready (${host}): ${file.name}`);
    } catch (err) {
      setRefVideoError(err.message);
      log("error", `Ref video upload failed: ${err.message}`);
    }
  }

  // =====================================================================
  // Image picker / drop
  // =====================================================================

  const handleImageFiles = useCallback(async (files) => {
    const accepted = files.filter((f) => isAllowedFile(f, "image"));
    if (accepted.length === 0) return;
    const items = await Promise.all(accepted.map(async (f) => ({ name: f.name, file: f, preview: await fileToPreview(f) })));
    setImages((p) => [...p, ...items]);
    log("info", `Added ${accepted.length} image(s)`);
  }, [log]);

  const removeImage = (i) => setImages((p) => p.filter((_, idx) => idx !== i));

  // =====================================================================
  // Batch control
  // =====================================================================

  async function startBatch() {
    if (!apiKey || !refVideoUrlRef.current || images.length === 0 || refVideoError) return;
    const videoUrl = refVideoUrlRef.current;

    const initial = images.map((img, i) => ({
      id: i,
      imageName: img.name,
      file: img.file,
      preview: img.preview,
      status: "pending",
      taskId: null,
      videoUrl: null,
      imageUrl: null,
      uploadProviderUsed: null,
      hostSnapshot: uploadHost,
      normalizedFile: null,
      jobProxyId: null,
      jobProxyUrl: null,
      firstPollLogged: false,
      error: null,
      retries: 0,
    }));
    jobsRef.current = initial;
    setJobs([...initial]);
    setRunning(true);
    setBatchDone(false);

    log("info", `Starting batch: ${initial.length} job(s), host=${uploadHost}, mode=${mode}`);

    startPolling();
    for (const job of initial) submitSingleJob(job, videoUrl);
  }

  async function retryJob(id) {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    updateJob(id, { retries: 0, jobProxyId: null, jobProxyUrl: null, firstPollLogged: false });
    if (batchDone) { setBatchDone(false); setRunning(true); }
    const fresh = jobsRef.current.find((j) => j.id === id) || job;
    await submitSingleJob(fresh, refVideoUrlRef.current, { forceReupload: true, attempt: 1 });
    if (!pollRef.current) startPolling();
  }

  async function replaceAndRetry(id, newFile) {
    if (!isAllowedFile(newFile, "image")) {
      log("error", `Replacement rejected: ${newFile?.name}`);
      return;
    }
    const preview = await fileToPreview(newFile);
    updateJob(id, { file: newFile, imageName: newFile.name, preview, status: "uploading", imageUrl: null, retries: 0, normalizedFile: null, jobProxyId: null, jobProxyUrl: null, firstPollLogged: false, error: null });
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    if (batchDone) { setBatchDone(false); setRunning(true); }
    await submitSingleJob(job, refVideoUrlRef.current, { forceReupload: true, attempt: 0 });
    if (!pollRef.current) startPolling();
  }

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const active = jobsRef.current.filter((j) => j.status === "processing");
      if (active.length === 0) {
        const waiting = jobsRef.current.some((j) => ["uploading", "retrying", "pending"].includes(j.status));
        if (!waiting) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setRunning(false);
          setBatchDone(true);
        }
        return;
      }

      for (const job of active) {
        try {
          const firstPoll = !job.firstPollLogged;
          if (firstPoll) updateJob(job.id, { firstPollLogged: true });
          const data = await checkJob(job, { firstPoll });
          if (data?.status === "completed") {
            const vUrl = data?.output?.works?.[0]?.video?.resource_without_watermark || data?.output?.works?.[0]?.video?.resource || "";
            updateJob(job.id, { status: "completed", videoUrl: vUrl });
            log("success", `[Job ${job.id + 1}] Completed`);
          } else if (data?.status === "failed") {
            const errMsg = data?.error?.raw_message || data?.error?.message || "Generation failed";
            updateJob(job.id, { error: errMsg });
            log("error", `[Job ${job.id + 1}] ${errMsg}`);

            const current = jobsRef.current.find((j) => j.id === job.id);
            const next = (current?.retries || 0) + 1;
            const vurl = refVideoUrlRef.current;

            if (isImageDecodeFetchError(errMsg) && (current?.retries || 0) < MAX_AUTO_RETRIES) {
              const reason = isFreezePointError(errMsg) ? "freeze_point" : "decode_fetch";
              const label = reason === "freeze_point" ? "Freeze-point" : "Decode/fetch";
              log("warn", `[Job ${job.id + 1}] ${label} — re-uploading (attempt ${next}/${MAX_AUTO_RETRIES})`);
              await autoRetry(current, vurl, { forceReupload: true, reason });
            } else if (isContentFilterError(errMsg) && (current?.retries || 0) < MAX_AUTO_RETRIES) {
              log("warn", `[Job ${job.id + 1}] Content filter — retrying (attempt ${next}/${MAX_AUTO_RETRIES})`);
              await autoRetry(current, vurl, { forceReupload: true, reason: "content_filter" });
            } else {
              updateJob(job.id, { status: "failed" });
            }
          }
        } catch (_) {}
      }
    }, POLL_INTERVAL);
  }

  function resetBatch() {
    setJobs([]);
    jobsRef.current = [];
    setBatchDone(false);
    setImages([]);
    setRefVideoFileName("");
    setRefVideoError("");
    setVideoDuration(10);
    refVideoUrlRef.current = "";
    refVideoFileRef.current = null;
    setZipProgress({ phase: "idle", done: 0, total: 0, percent: 0 });
    setLogs([]);

    // Reset proxy pool — fresh session. Refetch from Webshare if enabled.
    proxyPoolRef.current = null;
    setProxyCount(0);
    if (useProxy && webshareKey) {
      loadProxies(webshareKey, { silent: false });
    }
    log("info", "New batch — session reset");
  }

  // =====================================================================
  // Download / ZIP
  // =====================================================================

  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const processingCount = jobs.filter((j) => ["processing", "uploading", "retrying"].includes(j.status)).length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const spent = completedCount * perVideo;

  const safeDownloadName = (job) => `${safeBase(job.imageName)}.mp4`;
  const proxyDownload = (job) => `/api/piapi?action=download_proxy&url=${encodeURIComponent(job.videoUrl)}&filename=${encodeURIComponent(safeDownloadName(job))}`;

  async function downloadAllZip() {
    if (zipProgress.phase !== "idle" && zipProgress.phase !== "done") return;
    const completed = jobs.filter((j) => j.status === "completed");
    if (completed.length === 0) return;

    setZipProgress({ phase: "downloading", done: 0, total: completed.length, percent: 0 });
    log("info", `Fetching ${completed.length} videos in parallel…`);

    const zip = new JSZip();
    const folder = zip.folder("kling-batch-videos");
    let done = 0;
    let ok = 0;

    await Promise.all(completed.map(async (job) => {
      try {
        const r = await fetch(proxyDownload(job));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        folder.file(safeDownloadName(job), blob, { compression: "STORE" });
        ok++;
      } catch (err) {
        log("error", `[Job ${job.id + 1}] Download failed: ${err.message}`);
      } finally {
        done++;
        setZipProgress({ phase: "downloading", done, total: completed.length, percent: Math.round((done / completed.length) * 100) });
      }
    }));

    if (ok === 0) {
      log("error", `ZIP aborted: no videos downloaded`);
      setZipProgress({ phase: "idle", done: 0, total: 0, percent: 0 });
      return;
    }

    setZipProgress({ phase: "zipping", done: ok, total: completed.length, percent: 0 });
    log("info", `Building ZIP (STORE) with ${ok}/${completed.length} videos…`);

    const zipBlob = await zip.generateAsync(
      { type: "blob", compression: "STORE", streamFiles: true },
      (metadata) => setZipProgress((p) => ({ ...p, phase: "zipping", percent: Math.round(metadata.percent) }))
    );

    const link = document.createElement("a");
    link.href = URL.createObjectURL(zipBlob);
    link.download = `kling-batch-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    log("success", `ZIP: ${ok} of ${completed.length} videos`);
    setZipProgress({ phase: "done", done: ok, total: completed.length, percent: 100 });
    setTimeout(() => setZipProgress({ phase: "idle", done: 0, total: 0, percent: 0 }), 2000);
  }

  // =====================================================================
  // Render
  // =====================================================================

  const isProd = typeof import.meta !== "undefined" && import.meta.env?.PROD;
  const showVercelSizeWarning = isProd && refVideoFileRef.current && refVideoFileRef.current.size > VERCEL_HOBBY_LIMIT;

  const logColor = (t) => t === "error" ? c.error : t === "warn" ? c.warn : t === "success" ? c.success : c.muted;

  return (
    <div style={{ minHeight: "100vh", background: c.bg, color: c.text, fontFamily: font }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        input[type="file"] { display:none }
        ::-webkit-scrollbar { width:5px }
        ::-webkit-scrollbar-track { background:${c.bg} }
        ::-webkit-scrollbar-thumb { background:${c.border};border-radius:3px }
        button { font-family:${font} }
        select { font-family:${mono}; background:${c.surface}; color:${c.text}; border:1px solid ${c.border}; border-radius:5px; padding:7px 10px; font-size:11px; outline:none; width:100%; cursor:pointer; }
        select:focus { border-color:${c.accent}; }
        select:disabled { opacity:0.5; cursor:not-allowed; }
      `}</style>

      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: `1px solid ${c.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: c.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#fff" }}>K</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Kling Batch Motion Control</div>
            <div style={{ fontSize: 10, color: c.hint, fontFamily: mono }}>v2.6 · Litterbox / tmpfile.link · concurrent · auto-retry</div>
          </div>
        </div>
        {!connected ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input type="password" placeholder="PiAPI API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apiKey && setConnected(true)} style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 5, padding: "5px 10px", color: c.text, fontFamily: mono, fontSize: 11, width: 250, outline: "none" }} />
            <button onClick={() => apiKey && setConnected(true)} style={{ background: c.accent, border: "none", borderRadius: 5, padding: "5px 14px", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Connect</button>
          </div>
        ) : (
          <div style={{ fontSize: 10, fontFamily: mono, color: c.success, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: c.success }} />
            Connected
          </div>
        )}
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 63px)" }}>
        {/* Sidebar */}
        <div style={{ width: 340, borderRight: `1px solid ${c.border}`, padding: 20, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          {/* Reference video */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>Reference motion video</div>
            {refVideoFileName && (<div style={{ fontSize: 11, color: c.success, marginBottom: 8, fontFamily: mono }}>✓ {refVideoFileName}</div>)}
            {!!refVideoError && <div style={{ fontSize: 10, color: c.error, marginTop: 5 }}>{refVideoError}</div>}

            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, color: c.muted, marginBottom: 4 }}>Upload video file:</div>
              <div
                onClick={() => !running && document.getElementById("videoFileInput")?.click()}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                onDragEnter={(e) => {
                  e.preventDefault();
                  if (running) return;
                  videoDragCounter.current += 1;
                  setIsVideoDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  videoDragCounter.current = Math.max(0, videoDragCounter.current - 1);
                  if (videoDragCounter.current === 0) setIsVideoDragOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  videoDragCounter.current = 0;
                  setIsVideoDragOver(false);
                  if (running) return;
                  handleRefVideoFile(e.dataTransfer.files?.[0]);
                }}
                style={{
                  border: `1px dashed ${isVideoDragOver ? c.accent : c.border}`, borderRadius: 5,
                  padding: "8px 10px", textAlign: "center", cursor: running ? "default" : "pointer",
                  background: isVideoDragOver ? c.accent + "10" : c.surface, fontSize: 10,
                  color: isVideoDragOver ? c.accent : c.muted, transition: "all 0.2s ease",
                }}
              >
                {isVideoDragOver ? "Drop video file here" : "Click or drag & drop MP4/MOV (max 50MB)"}
              </div>
              <input
                id="videoFileInput" type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  await handleRefVideoFile(file);
                }}
                disabled={running}
              />
              {showVercelSizeWarning && (
                <div style={{ fontSize: 10, color: c.warn, marginTop: 6, lineHeight: 1.4 }}>
                  Large file on Vercel: upload may fail on Hobby plan (4.5MB body limit).
                </div>
              )}
            </div>
          </div>

          {/* Host dropdown */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>File host</div>
            <select value={uploadHost} onChange={(e) => setUploadHost(e.target.value)} disabled={running}>
              {HOST_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label} (max {opt.maxConcurrent} concurrent)</option>
              ))}
            </select>
          </div>

          {/* Proxy section */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted }}>Upload proxy</div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: running ? "default" : "pointer" }}>
                <input
                  type="checkbox"
                  checked={useProxy}
                  onChange={(e) => setUseProxy(e.target.checked)}
                  disabled={running}
                  style={{ margin: 0 }}
                />
                <span style={{ fontSize: 10, color: useProxy ? c.accent : c.muted, fontFamily: mono }}>
                  {useProxy ? "ON" : "OFF"}
                </span>
              </label>
            </div>

            {useProxy && !webshareKey && (
              <div style={{ display: "grid", gap: 6 }}>
                <input
                  type="password"
                  placeholder="Webshare API Key"
                  value={webshareInput}
                  onChange={(e) => setWebshareInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !proxyLoading && handleSaveWebshareKey()}
                  disabled={proxyLoading || running}
                  style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 5, padding: "6px 10px", color: c.text, fontFamily: mono, fontSize: 11, outline: "none" }}
                />
                <button
                  onClick={handleSaveWebshareKey}
                  disabled={!webshareInput.trim() || proxyLoading || running}
                  style={{
                    padding: "6px 0", borderRadius: 5,
                    background: !webshareInput.trim() || proxyLoading ? c.tag : c.accent,
                    border: "none", color: "#fff", fontSize: 11, fontWeight: 600,
                    cursor: proxyLoading || !webshareInput.trim() ? "default" : "pointer",
                  }}
                >
                  {proxyLoading ? "Loading proxies…" : "Save"}
                </button>
                {!!proxyError && <div style={{ fontSize: 10, color: c.error }}>{proxyError}</div>}
                <div style={{ fontSize: 9, color: c.hint, lineHeight: 1.4 }}>
                  Fetches the full proxy list from Webshare (direct mode). One unique proxy per upload; pool is session-only.
                </div>
              </div>
            )}

            {useProxy && webshareKey && (
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 10, color: c.success, fontFamily: mono }}>
                  ✓ Webshare connected — {proxyCount || "…"} proxies
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 9, color: c.muted, fontFamily: mono }}>Protocol</span>
                  <select
                    value={proxyProtocol}
                    onChange={(e) => handleChangeProtocol(e.target.value)}
                    disabled={running || proxyLoading}
                    style={{ flex: 1, background: c.surface, border: `1px solid ${c.border}`, borderRadius: 4, padding: "3px 6px", color: c.text, fontFamily: mono, fontSize: 10, outline: "none" }}
                  >
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </div>
                <div style={{ fontSize: 9, color: c.hint, lineHeight: 1.4 }}>
                  SOCKS5 requires a Webshare plan with SOCKS5 enabled.
                </div>
                {proxyPoolRef.current && (
                  <div style={{ fontSize: 9, color: c.hint, fontFamily: mono }}>
                    Pool: {proxyPoolRef.current.remaining()} available, {proxyPoolRef.current.burnedCount()} burned
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => loadProxies(webshareKey)}
                    disabled={proxyLoading || running}
                    style={{ background: "transparent", border: `1px solid ${c.border}`, color: c.muted, fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: proxyLoading ? "default" : "pointer", fontFamily: mono }}
                  >
                    {proxyLoading ? "…" : "Reload"}
                  </button>
                  <button
                    onClick={handleChangeWebshareKey}
                    disabled={running}
                    style={{ background: "transparent", border: `1px solid ${c.border}`, color: c.muted, fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontFamily: mono }}
                  >
                    Change key
                  </button>
                </div>
                {!!proxyError && <div style={{ fontSize: 10, color: c.error }}>{proxyError}</div>}
              </div>
            )}
          </div>

          {/* Logs */}
          <div style={{ background: c.surface, borderRadius: 7, border: `1px solid ${c.border}` }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${c.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 10, color: c.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Runtime logs</div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={copyLogs} style={{ border: `1px solid ${c.border}`, background: c.bg, borderRadius: 5, padding: "3px 8px", color: c.text, fontSize: 10, cursor: "pointer" }}>Copy</button>
                <button onClick={() => setLogs([])} style={{ border: `1px solid ${c.border}`, background: c.bg, borderRadius: 5, padding: "3px 8px", color: c.text, fontSize: 10, cursor: "pointer" }}>Clear</button>
              </div>
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", padding: "8px 10px", display: "grid", gap: 3 }}>
              {logs.length === 0 ? (
                <div style={{ fontSize: 10, color: c.hint }}>No logs.</div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} style={{ fontSize: 10, fontFamily: mono, color: logColor(l.type), lineHeight: 1.5, wordBreak: "break-word" }}>
                    <span style={{ color: c.hint }}>[{l.ts}]</span> {l.message}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

          {/* Images */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>Character images ({images.length})</div>
            <div
              onClick={() => !running && imgRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDragEnter={(e) => {
                e.preventDefault();
                if (running) return;
                imageDragCounter.current += 1;
                setIsImageDragOver(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                imageDragCounter.current = Math.max(0, imageDragCounter.current - 1);
                if (imageDragCounter.current === 0) setIsImageDragOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                imageDragCounter.current = 0;
                setIsImageDragOver(false);
                if (running) return;
                handleImageFiles(Array.from(e.dataTransfer.files || []));
              }}
              style={{
                border: `1px dashed ${isImageDragOver ? c.accent : c.border}`, borderRadius: 7,
                padding: 12, textAlign: "center", cursor: running ? "default" : "pointer",
                background: isImageDragOver ? c.accent + "10" : c.surface, marginBottom: 6,
                transition: "all 0.2s ease",
              }}
            >
              <input
                ref={imgRef} type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                multiple
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = "";
                  await handleImageFiles(files);
                }}
              />
              <div style={{ fontSize: 11, color: isImageDragOver ? c.accent : c.muted }}>
                {isImageDragOver ? "Drop images here" : "Click or drag & drop images"}
              </div>
            </div>
            {images.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {images.map((img, i) => (
                  <div key={i} style={{ position: "relative", width: 44, height: 44 }}>
                    <img src={img.preview} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 5, border: `1px solid ${c.border}` }} />
                    {!running && <button onClick={(e) => { e.stopPropagation(); removeImage(i); }} style={{ position: "absolute", top: -3, right: -3, width: 14, height: 14, borderRadius: "50%", background: c.error, border: "none", color: "#fff", fontSize: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Settings */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted }}>Settings</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["std", "Standard", "0.065"], ["pro", "Pro", "0.104"]].map(([v, l, p]) => (
                <button key={v} onClick={() => !running && setMode(v)} style={{
                  flex: 1, padding: "7px 0", borderRadius: 5,
                  border: `1px solid ${mode === v ? c.accent : c.border}`,
                  background: mode === v ? c.accent + "15" : c.surface,
                  color: mode === v ? c.accent : c.muted,
                  fontSize: 11, fontWeight: 600, cursor: running ? "default" : "pointer",
                }}>
                  {l} <span style={{ fontFamily: mono, fontSize: 9, opacity: 0.7 }}>${p}/s</span>
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["video", "Match Video"], ["image", "Match Image"]].map(([v, l]) => (
                <button key={v} onClick={() => !running && setOrientation(v)} style={{
                  flex: 1, padding: "7px 0", borderRadius: 5,
                  border: `1px solid ${orientation === v ? c.accent : c.border}`,
                  background: orientation === v ? c.accent + "15" : c.surface,
                  color: orientation === v ? c.accent : c.muted,
                  fontSize: 11, fontWeight: 600, cursor: running ? "default" : "pointer",
                }}>{l}</button>
              ))}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: c.muted, cursor: running ? "default" : "pointer" }}>
              <input type="checkbox" checked={keepSound} onChange={(e) => !running && setKeepSound(e.target.checked)} disabled={running} />
              Keep original sound
            </label>
          </div>

          {/* Cost */}
          <div style={{ background: c.surface, borderRadius: 7, padding: 12, border: `1px solid ${c.border}` }}>
            <div style={{ fontSize: 10, color: c.muted, marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Cost estimate</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}><span style={{ fontSize: 11, color: c.muted }}>Per video ({videoDuration}s)</span><span style={{ fontSize: 11, fontFamily: mono }}>${perVideo.toFixed(2)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 11, color: c.muted }}>Batch ({images.length})</span><span style={{ fontSize: 13, fontFamily: mono, fontWeight: 700, color: c.accent }}>${batchEst.toFixed(2)}</span></div>
          </div>

          {jobs.length === 0 ? (
            <button onClick={startBatch} disabled={running || !connected || !refVideoUrlRef.current || !!refVideoError || images.length === 0} style={{ width: "100%", padding: "12px 0", borderRadius: 7, background: running || !connected || !refVideoUrlRef.current || !!refVideoError || images.length === 0 ? c.tag : c.accent, border: "none", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Generate {images.length} video{images.length !== 1 ? "s" : ""}
            </button>
          ) : (
            <button onClick={resetBatch} style={{ width: "100%", padding: "12px 0", borderRadius: 7, background: c.surface, border: `1px solid ${c.border}`, color: c.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>New batch</button>
          )}
        </div>

        {/* Main panel */}
        <div style={{ flex: 1, padding: 20, overflowY: "auto" }}>
          {jobs.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "50vh", color: c.muted, fontSize: 12, flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 28, opacity: 0.25 }}>⬡</div>
              <div>Drop a reference MP4/MOV and character images to start</div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 14, marginBottom: 16, padding: "10px 14px", background: c.surface, borderRadius: 7, border: `1px solid ${c.border}`, alignItems: "center", flexWrap: "wrap" }}>
                {[[c.success, "Done", completedCount], [c.accent, "Running", processingCount], [c.error, "Failed", failedCount]].map(([col, label, count]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: col }} />
                    <span style={{ fontSize: 10, fontFamily: mono, color: col, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                    <span style={{ fontSize: 12, fontFamily: mono, fontWeight: 600 }}>{count}</span>
                  </div>
                ))}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                  {completedCount > 0 && <ZipButton count={completedCount} progress={zipProgress} onClick={downloadAllZip} />}
                  <div style={{ fontSize: 11, fontFamily: mono, color: c.accent }}>Spent: ${spent.toFixed(2)}</div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {jobs.map((job, idx) => (
                  <div key={job.id} style={{ background: c.surface, borderRadius: 9, border: `1px solid ${job.status === "failed" ? c.error + "40" : c.border}`, overflow: "hidden", animation: "fadeIn 0.3s ease", animationDelay: `${idx * 40}ms`, animationFillMode: "both" }}>
                    <div style={{ position: "relative", aspectRatio: "16/9", background: c.bg }}>
                      {job.videoUrl ? <video src={job.videoUrl} controls style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <img src={job.preview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: ["processing", "uploading", "retrying"].includes(job.status) ? 0.4 : 0.7 }} />}
                    </div>
                    <div style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontSize: 10, fontFamily: mono, color: c.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{job.imageName}</span>
                        <StatusBadge status={job.status} retries={job.retries || 0} />
                      </div>
                      {job.uploadProviderUsed && <div style={{ fontSize: 9, color: c.hint, fontFamily: mono, marginBottom: 4 }}>Upload: {job.uploadProviderUsed}</div>}

                      {job.status === "failed" && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 10, color: c.error, lineHeight: 1.4, padding: "6px 8px", background: c.error + "12", borderRadius: 4, border: `1px solid ${c.error}30`, marginBottom: 8, wordBreak: "break-word" }}>{job.error || "Unknown error"}</div>
                          <div style={{ display: "flex", gap: 5 }}>
                            <button onClick={() => retryJob(job.id)} style={{ flex: 1, padding: "7px 0", borderRadius: 5, background: c.accent, border: "none", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Retry</button>
                            <button onClick={() => replaceImgRefs.current[job.id]?.click()} style={{ flex: 1, padding: "7px 0", borderRadius: 5, background: c.surface, border: `1px solid ${c.border}`, color: c.text, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Replace</button>
                          </div>
                        </div>
                      )}

                      <input ref={(el) => { replaceImgRefs.current[job.id] = el; }} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) replaceAndRetry(job.id, f); e.target.value = ""; }} />

                      {job.videoUrl && (
                        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <a href={proxyDownload(job)} download={safeDownloadName(job)} style={{ flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 5, background: c.accent + "18", color: c.accent, fontSize: 10, fontWeight: 600, textDecoration: "none", border: `1px solid ${c.accent}30` }}>Download</a>
                            <button onClick={() => {
                              updateJob(job.id, { status: "uploading", videoUrl: null, taskId: null, error: null, imageUrl: null, jobProxyId: null, jobProxyUrl: null, firstPollLogged: false });
                              submitSingleJob(job, refVideoUrlRef.current, { forceReupload: true, attempt: 1 });
                              if (!pollRef.current) startPolling();
                              log("info", `Regenerating ${job.imageName}`);
                            }} style={{ flex: 1, padding: "7px 0", borderRadius: 5, background: c.warn + "20", border: `1px solid ${c.warn}40`, color: c.warn, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Regenerate</button>
                          </div>
                          <a href={job.videoUrl} download={safeDownloadName(job)} target="_blank" rel="noreferrer" style={{ textAlign: "center", fontSize: 9, color: c.hint, textDecoration: "none" }}>Direct link</a>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <Analytics />
    </div>
  );
}
