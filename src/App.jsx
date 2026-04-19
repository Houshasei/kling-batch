import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Analytics } from "@vercel/analytics/react";
import JSZip from "jszip";

const POLL_INTERVAL = 8000;
const MAX_AUTO_RETRIES = 5;
const UPLOAD_PROPAGATION_MS = 2000;
const STORAGE_API_KEY = "kling_batch_api_key";
const STORAGE_UPLOAD_HOST = "kling_batch_upload_host";
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const VERCEL_HOBBY_LIMIT = 4 * 1024 * 1024;
const LOG_BUFFER = 500;

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

const HOST_OPTIONS = [
  { id: "litterbox", label: "Litterbox \u00B7 1h" },
  { id: "0x0", label: "0x0.st" },
];

const VIDEO_EXTS = ["mp4", "mov"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp"];

class ProxyError extends Error {
  constructor(message, { status, action, body } = {}) {
    super(message);
    this.name = "ProxyError";
    this.status = status;
    this.action = action;
    this.body = body;
  }
}

function fileToPreview(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(file);
  });
}

function fileExt(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "";
}

function isAllowedFile(file, kind) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  const ext = fileExt(file.name);
  if (kind === "video") {
    if (type.startsWith("video/")) return true;
    return VIDEO_EXTS.includes(ext);
  }
  if (kind === "image") {
    if (type.startsWith("image/")) return true;
    return IMAGE_EXTS.includes(ext);
  }
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

function truncate(str, max = 2048) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) + `… (+${s.length - max} chars)` : s;
}

function formatTs() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

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

function LogEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const color = entry.type === "error" ? c.error : entry.type === "warn" ? c.warn : entry.type === "success" ? c.success : entry.type === "debug" ? c.hint : c.muted;
  const jobTag = entry.jobId != null ? `[Job ${entry.jobId + 1}] ` : "";
  const stageTag = entry.stage && entry.stage !== "system" ? `[${entry.stage}] ` : "";
  return (
    <div style={{ fontSize: 10, fontFamily: mono, color, lineHeight: 1.5 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
        <span style={{ color: c.hint, flexShrink: 0 }}>[{entry.ts}]</span>
        <span style={{ flex: 1, wordBreak: "break-word" }}>{stageTag}{jobTag}{entry.message}</span>
        {entry.detail && (
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ background: "transparent", border: "none", color: c.hint, fontFamily: mono, fontSize: 10, cursor: "pointer", padding: 0, flexShrink: 0 }}
            title="Toggle detail"
          >
            {open ? "\u25BE" : "\u25B8"}
          </button>
        )}
      </div>
      {open && entry.detail && (
        <pre style={{ margin: "4px 0 4px 18px", padding: "6px 8px", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 4, color: c.text, fontFamily: mono, fontSize: 10, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {entry.detail}
        </pre>
      )}
    </div>
  );
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_API_KEY) || "");
  const [connected, setConnected] = useState(() => Boolean(localStorage.getItem(STORAGE_API_KEY)));
  const [uploadHost, setUploadHost] = useState(() => localStorage.getItem(STORAGE_UPLOAD_HOST) || "litterbox");

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
  const [logFilter, setLogFilter] = useState("all");
  const [logSearch, setLogSearch] = useState("");
  const [debugLogs, setDebugLogs] = useState(false);
  const [zipProgress, setZipProgress] = useState({ phase: "idle", done: 0, total: 0, percent: 0 });

  const imgRef = useRef();
  const replaceImgRefs = useRef({});
  const jobsRef = useRef([]);
  const pollRef = useRef(null);
  const refVideoUrlRef = useRef("");
  const refVideoFileRef = useRef(null);
  const logsEndRef = useRef(null);
  const logsContainerRef = useRef(null);
  const autoScrollRef = useRef(true);
  const videoDragCounter = useRef(0);
  const imageDragCounter = useRef(0);
  const debugRef = useRef(false);

  useEffect(() => { debugRef.current = debugLogs; }, [debugLogs]);

  const rate = mode === "std" ? 0.065 : 0.104;
  const perVideo = rate * videoDuration;
  const batchEst = perVideo * images.length;

  const logEvent = useCallback(({ type = "info", stage = "system", jobId = null, message, detail = null }) => {
    setLogs((prev) => {
      const next = [...prev, { id: Date.now() + Math.random(), ts: formatTs(), type, stage, jobId, message, detail }];
      return next.length > LOG_BUFFER ? next.slice(next.length - LOG_BUFFER) : next;
    });
  }, []);

  const log = useCallback((type, message, detail = null) => {
    logEvent({ type, stage: "system", message, detail });
  }, [logEvent]);

  const debugLog = useCallback((message, detail = null) => {
    if (!debugRef.current) return;
    logEvent({ type: "debug", stage: "system", message, detail });
  }, [logEvent]);

  useEffect(() => {
    const el = logsContainerRef.current;
    if (!el) return;
    if (autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    localStorage.setItem(STORAGE_API_KEY, apiKey || "");
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem(STORAGE_UPLOAD_HOST, uploadHost);
  }, [uploadHost]);

  // Global drop guard: prevent browser from navigating when files are dropped outside drop zones.
  useEffect(() => {
    const onDragOver = (e) => { e.preventDefault(); };
    const onDrop = (e) => { e.preventDefault(); };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return logs.filter((l) => {
      if (logFilter !== "all" && l.type !== logFilter) return false;
      if (q) {
        const hay = `${l.message} ${l.detail || ""} ${l.stage || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [logs, logFilter, logSearch]);

  function handleLogsScroll() {
    const el = logsContainerRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }

  function copyLogs() {
    const text = filteredLogs.map((l) => {
      const prefix = `[${l.ts}] [${l.stage}]${l.jobId != null ? ` [Job ${l.jobId + 1}]` : ""} [${l.type}] ${l.message}`;
      return l.detail ? `${prefix}\n${l.detail}` : prefix;
    }).join("\n");
    navigator.clipboard?.writeText(text).then(
      () => log("success", "Logs copied to clipboard"),
      (err) => log("error", `Copy failed: ${err.message}`)
    );
  }

  const handleImageFiles = useCallback(async (files) => {
    const accepted = files.filter((f) => isAllowedFile(f, "image"));
    if (accepted.length === 0) return;
    const items = await Promise.all(accepted.map(async (f) => ({ name: f.name, file: f, preview: await fileToPreview(f) })));
    setImages((p) => [...p, ...items]);
    log("info", `Added ${accepted.length} image(s)`);
  }, [log]);

  const removeImage = (i) => setImages((p) => p.filter((_, idx) => idx !== i));

  async function proxyJson(body) {
    const action = body?.action;
    const needsApiKey = action === "create" || action === "poll";
    const payload = needsApiKey ? { apiKey, ...body } : body;
    if (debugRef.current) {
      debugLog(`-> /api/piapi ${action}`, truncate(JSON.stringify(payload), 1024));
    }
    let r;
    try {
      r = await fetch("/api/piapi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new ProxyError(`Network error calling ${action}: ${err.message}`, { action });
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (debugRef.current) {
      debugLog(`<- /api/piapi ${action} ${r.status}`, truncate(text, 1024));
    }
    if (!r.ok) {
      throw new ProxyError(
        json?.error || json?.message || `HTTP ${r.status}`,
        { status: r.status, action, body: text }
      );
    }
    if (json && json.error) {
      throw new ProxyError(json.error, { status: r.status, action, body: text });
    }
    return json ?? {};
  }

  function extractUploadUrl(resp) {
    return (
      resp?.data?.downloadLinkEncoded ||
      resp?.data?.downloadLink ||
      resp?.downloadLinkEncoded ||
      resp?.downloadLink ||
      ""
    );
  }

  async function uploadToHost(file, host, { stage = "upload", jobId = null, label = "" } = {}) {
    const chosenHost = host || uploadHost;
    const tag = label ? `${label}: ` : "";
    logEvent({ type: "info", stage, jobId, message: `${tag}Uploading to ${chosenHost} (${(file.size / 1024 / 1024).toFixed(2)}MB)` });

    const formData = new FormData();
    formData.append("file", file);
    formData.append("action", "upload_file");
    formData.append("host", chosenHost);

    let r;
    try {
      r = await fetch("/api/piapi", { method: "POST", body: formData });
    } catch (err) {
      throw new ProxyError(`Network error during upload: ${err.message}`, { action: "upload_file" });
    }

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!r.ok) {
      const isSizeErr = r.status === 413 || r.status === 504 || /payload too large|request entity too large/i.test(text);
      if (isSizeErr && import.meta.env?.PROD) {
        logEvent({
          type: "warn",
          stage,
          jobId,
          message: `${tag}Proxy rejected (${r.status}) — file likely exceeds Vercel body limit. Attempting direct browser upload…`,
          detail: truncate(text, 2048),
        });
        try {
          const direct = await directHostUpload(file, chosenHost);
          logEvent({ type: "success", stage, jobId, message: `${tag}Uploaded directly to ${chosenHost}: ${direct}` });
          await new Promise((res) => setTimeout(res, UPLOAD_PROPAGATION_MS));
          return { url: direct, host: chosenHost };
        } catch (derr) {
          throw new ProxyError(
            `Upload failed (proxy ${r.status}, direct: ${derr.message}). On Vercel Hobby, body limit is ~4.5MB. Use a smaller file or upgrade to Pro.`,
            { status: r.status, action: "upload_file", body: `${text}\n---\nDirect: ${derr.message}` }
          );
        }
      }
      throw new ProxyError(
        json?.error || json?.message || `Upload HTTP ${r.status}`,
        { status: r.status, action: "upload_file", body: truncate(text, 4096) }
      );
    }

    const url = extractUploadUrl(json || {});
    if (!url) {
      throw new ProxyError("Upload returned no URL", { status: r.status, action: "upload_file", body: truncate(text, 2048) });
    }
    const finalHost = json?.data?.uploadedTo || chosenHost;
    logEvent({ type: "success", stage, jobId, message: `${tag}Uploaded via ${finalHost}: ${url}` });
    await new Promise((res) => setTimeout(res, UPLOAD_PROPAGATION_MS));
    debugLog(`Propagation wait ${UPLOAD_PROPAGATION_MS}ms done (${finalHost})`);
    return { url, host: finalHost };
  }

  async function directHostUpload(file, host) {
    if (host === "litterbox") {
      const fd = new FormData();
      fd.append("reqtype", "fileupload");
      fd.append("time", "1h");
      fd.append("fileToUpload", file);
      const r = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", { method: "POST", body: fd });
      const t = (await r.text()).trim();
      if (!r.ok || !/^https?:\/\//.test(t)) throw new Error(t || `HTTP ${r.status}`);
      return t;
    }
    // 0x0.st rejects browser-origin due to CORS; attempt anyway.
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("https://0x0.st", { method: "POST", body: fd });
    const t = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//.test(t)) throw new Error(t || `HTTP ${r.status}`);
    return t;
  }

  async function submitCreateTask(imageUrl, videoUrl, jobId) {
    try {
      const d = await proxyJson({
        action: "create",
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
      });
      if (d?.data?.task_id) return d.data.task_id;
      const msg = d?.message || d?.error?.message || d?.error || "Create task failed";
      throw new ProxyError(msg, { action: "create", body: truncate(JSON.stringify(d), 2048) });
    } catch (err) {
      if (err instanceof ProxyError) throw err;
      throw new ProxyError(err.message, { action: "create" });
    }
  }

  async function checkJob(taskId) {
    const d = await proxyJson({ action: "poll", taskId });
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
      s.includes("fetch")
    );
  }

  async function submitSingleJob(job, videoUrl, { forceReupload = false } = {}) {
    try {
      updateJob(job.id, { status: "uploading", error: null });
      const fileToUpload = job.file;
      if (!fileToUpload || !(fileToUpload instanceof File)) {
        throw new Error("Invalid file object");
      }

      let imageUrl = job.imageUrl;
      if (!imageUrl || forceReupload) {
        const hostSnapshot = job.hostSnapshot || uploadHost;
        const { url, host } = await uploadToHost(fileToUpload, hostSnapshot, { stage: "upload", jobId: job.id });
        imageUrl = url;
        updateJob(job.id, { imageUrl: url, uploadProviderUsed: host });
      }

      logEvent({ type: "info", stage: "create", jobId: job.id, message: `Submitting to Kling API…` });
      const taskId = await submitCreateTask(imageUrl, videoUrl, job.id);
      updateJob(job.id, { status: "processing", taskId, error: null, videoUrl: null });
      logEvent({ type: "success", stage: "create", jobId: job.id, message: `Task submitted: ${taskId}` });
      return true;
    } catch (err) {
      const detail = err instanceof ProxyError
        ? `action=${err.action || "?"} status=${err.status || "?"}\n${truncate(err.body || "", 2048)}`
        : err?.stack || null;
      updateJob(job.id, { status: "failed", error: err.message });
      logEvent({ type: "error", stage: "upload", jobId: job.id, message: `Failed: ${err.message}`, detail });
      return false;
    }
  }

  async function autoRetry(job, videoUrl, { forceReupload = false } = {}) {
    const retries = (job.retries || 0) + 1;
    if (retries > MAX_AUTO_RETRIES) {
      updateJob(job.id, { status: "failed", retries });
      return;
    }
    updateJob(job.id, { status: "retrying", retries, error: null });
    await new Promise((r) => setTimeout(r, 1800));
    // On decode/fetch retries, drop the stale URL to force fresh re-upload.
    if (forceReupload) {
      const current = jobsRef.current.find((j) => j.id === job.id);
      if (current) updateJob(job.id, { imageUrl: null });
    }
    const fresh = jobsRef.current.find((j) => j.id === job.id);
    await submitSingleJob(fresh || job, videoUrl, { forceReupload });
  }

  async function handleRefVideoFile(file) {
    if (!file) return;
    if (!isAllowedFile(file, "video")) {
      setRefVideoError("Unsupported file. Use MP4 or MOV.");
      log("error", `Rejected ref video (type=${file.type || "unknown"}, ext=${fileExt(file.name)})`);
      return;
    }
    if (file.size > MAX_VIDEO_SIZE) {
      setRefVideoError(`Video file too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_VIDEO_SIZE / 1024 / 1024}MB`);
      log("error", `Video file too large: ${file.name}`);
      return;
    }
    try {
      setRefVideoError("");
      const { url, host } = await uploadToHost(file, uploadHost, { stage: "upload", jobId: null, label: "RefVideo" });
      refVideoUrlRef.current = url;
      refVideoFileRef.current = file;
      setRefVideoFileName(file.name);

      // Try to read duration client-side.
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
      const detail = err instanceof ProxyError ? `action=${err.action} status=${err.status}\n${truncate(err.body || "", 2048)}` : null;
      logEvent({ type: "error", stage: "upload", message: `Ref video upload failed: ${err.message}`, detail });
    }
  }

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
      error: null,
      retries: 0,
    }));
    jobsRef.current = initial;
    setJobs([...initial]);
    setRunning(true);
    setBatchDone(false);

    logEvent({ type: "info", stage: "system", message: `Starting batch: ${initial.length} job(s), host=${uploadHost}, mode=${mode}` });

    // Start polling immediately; fire all job chains in parallel.
    startPolling();
    for (const job of initial) {
      submitSingleJob(job, videoUrl);
    }
  }

  async function retryJob(id) {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    updateJob(id, { retries: 0 });
    if (batchDone) {
      setBatchDone(false);
      setRunning(true);
    }
    const vurl = refVideoUrlRef.current;
    await submitSingleJob(job, vurl, { forceReupload: true });
    if (!pollRef.current) startPolling();
  }

  async function replaceAndRetry(id, newFile) {
    if (!isAllowedFile(newFile, "image")) {
      log("error", `Replacement rejected (not a valid image): ${newFile?.name}`);
      return;
    }
    const preview = await fileToPreview(newFile);
    updateJob(id, { file: newFile, imageName: newFile.name, preview, status: "uploading", imageUrl: null, retries: 0, error: null });
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    if (batchDone) {
      setBatchDone(false);
      setRunning(true);
    }
    const vurl = refVideoUrlRef.current;
    await submitSingleJob(job, vurl, { forceReupload: true });
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
          const data = await checkJob(job.taskId);
          if (data?.status === "completed") {
            const vUrl = data?.output?.works?.[0]?.video?.resource_without_watermark || data?.output?.works?.[0]?.video?.resource || "";
            updateJob(job.id, { status: "completed", videoUrl: vUrl });
            logEvent({ type: "success", stage: "poll", jobId: job.id, message: `Video generation completed` });
          } else if (data?.status === "failed") {
            const errMsg = data?.error?.raw_message || data?.error?.message || "Generation failed";
            const detail = truncate(JSON.stringify(data?.error || data, null, 2), 2048);
            updateJob(job.id, { error: errMsg });
            logEvent({ type: "error", stage: "poll", jobId: job.id, message: `Generation failed: ${errMsg}`, detail });

            const current = jobsRef.current.find((j) => j.id === job.id);
            const attemptNext = (current?.retries || 0) + 1;
            const vurl = refVideoUrlRef.current;

            if (isImageDecodeFetchError(errMsg) && (current?.retries || 0) < MAX_AUTO_RETRIES) {
              logEvent({ type: "warn", stage: "poll", jobId: job.id, message: `Decode/fetch error detected — re-uploading (attempt ${attemptNext}/${MAX_AUTO_RETRIES})`, detail });
              await autoRetry(current, vurl, { forceReupload: true });
            } else if (isContentFilterError(errMsg) && (current?.retries || 0) < MAX_AUTO_RETRIES) {
              logEvent({ type: "warn", stage: "poll", jobId: job.id, message: `Content filter error — auto-retrying (attempt ${attemptNext}/${MAX_AUTO_RETRIES})` });
              await autoRetry(current, vurl);
            } else {
              updateJob(job.id, { status: "failed" });
            }
          }
        } catch (err) {
          debugLog(`Poll error for job ${job.id + 1}: ${err.message}`);
        }
      }
    }, POLL_INTERVAL);
  }

  function resetBatch() {
    setJobs([]);
    setBatchDone(false);
    setImages([]);
    setRefVideoFileName("");
    setRefVideoError("");
    setVideoDuration(10);
    refVideoUrlRef.current = "";
    refVideoFileRef.current = null;
    setZipProgress({ phase: "idle", done: 0, total: 0, percent: 0 });
  }

  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const processingCount = jobs.filter((j) => ["processing", "uploading", "retrying"].includes(j.status)).length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const spent = completedCount * perVideo;

  const safeDownloadName = (job) => `${safeBase(job.imageName)}.mp4`;
  const proxyDownload = (job) => `/api/piapi?action=download_proxy&url=${encodeURIComponent(job.videoUrl)}&filename=${encodeURIComponent(safeDownloadName(job))}`;

  async function downloadAllZip() {
    if (zipProgress.phase !== "idle" && zipProgress.phase !== "done") return;
    const completedJobs = jobs.filter((j) => j.status === "completed");
    if (completedJobs.length === 0) return;

    setZipProgress({ phase: "downloading", done: 0, total: completedJobs.length, percent: 0 });
    logEvent({ type: "info", stage: "zip", message: `Fetching ${completedJobs.length} videos in parallel…` });

    const zip = new JSZip();
    const folder = zip.folder("kling-batch-videos");
    let done = 0;
    let okCount = 0;

    await Promise.all(completedJobs.map(async (job) => {
      try {
        const r = await fetch(proxyDownload(job));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        folder.file(safeDownloadName(job), blob, { compression: "STORE" });
        okCount++;
      } catch (err) {
        logEvent({ type: "error", stage: "zip", jobId: job.id, message: `Download failed: ${err.message}`, detail: proxyDownload(job) });
      } finally {
        done++;
        const percent = Math.round((done / completedJobs.length) * 100);
        setZipProgress({ phase: "downloading", done, total: completedJobs.length, percent });
      }
    }));

    if (okCount === 0) {
      logEvent({ type: "error", stage: "zip", message: `ZIP aborted: no videos downloaded` });
      setZipProgress({ phase: "idle", done: 0, total: 0, percent: 0 });
      return;
    }

    setZipProgress({ phase: "zipping", done: okCount, total: completedJobs.length, percent: 0 });
    logEvent({ type: "info", stage: "zip", message: `Building ZIP (STORE) with ${okCount}/${completedJobs.length} videos…` });

    const zipBlob = await zip.generateAsync(
      { type: "blob", compression: "STORE", streamFiles: true },
      (metadata) => {
        setZipProgress((p) => ({ ...p, phase: "zipping", percent: Math.round(metadata.percent) }));
      }
    );

    const link = document.createElement("a");
    link.href = URL.createObjectURL(zipBlob);
    link.download = `kling-batch-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    logEvent({ type: "success", stage: "zip", message: `ZIP: added ${okCount} of ${completedJobs.length} videos` });
    setZipProgress({ phase: "done", done: okCount, total: completedJobs.length, percent: 100 });
    setTimeout(() => setZipProgress({ phase: "idle", done: 0, total: 0, percent: 0 }), 2000);
  }

  const isProd = typeof import.meta !== "undefined" && import.meta.env?.PROD;
  const showVercelSizeWarning = isProd && refVideoFileRef.current && refVideoFileRef.current.size > VERCEL_HOBBY_LIMIT;

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

      <div style={{ padding: "16px 24px", borderBottom: `1px solid ${c.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: c.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#fff" }}>K</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Kling Batch Motion Control</div>
            <div style={{ fontSize: 10, color: c.hint, fontFamily: mono }}>v2.6 · PiAPI · 0x0.st / Litterbox · concurrent pipeline</div>
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
            Connected (saved locally)
          </div>
        )}
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 63px)" }}>
        <div style={{ width: 340, borderRight: `1px solid ${c.border}`, padding: 20, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          {/* Reference motion video */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>Reference motion video</div>
            {refVideoFileName && (
              <div style={{ fontSize: 11, color: c.success, marginBottom: 8, fontFamily: mono }}>
                ✓ {refVideoFileName}
              </div>
            )}
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
                  const file = e.dataTransfer.files?.[0];
                  handleRefVideoFile(file);
                }}
                style={{
                  border: `1px dashed ${isVideoDragOver ? c.accent : c.border}`,
                  borderRadius: 5,
                  padding: "8px 10px",
                  textAlign: "center",
                  cursor: running ? "default" : "pointer",
                  background: isVideoDragOver ? c.accent + "10" : c.surface,
                  fontSize: 10,
                  color: isVideoDragOver ? c.accent : c.muted,
                  transition: "all 0.2s ease",
                }}
              >
                {isVideoDragOver ? "Drop video file here" : "Click to select or drag & drop video file (MP4/MOV, max 50MB)"}
              </div>
              <input
                id="videoFileInput"
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  await handleRefVideoFile(file);
                }}
                disabled={running}
                style={{ display: "none" }}
              />
              {showVercelSizeWarning && (
                <div style={{ fontSize: 10, color: c.warn, marginTop: 6, lineHeight: 1.4 }}>
                  Large file on Vercel: upload may fail on Hobby plan (4.5MB body limit). Consider Pro, or use a smaller video.
                </div>
              )}
            </div>
          </div>

          {/* File host dropdown */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>File host</div>
            <select
              value={uploadHost}
              onChange={(e) => setUploadHost(e.target.value)}
              disabled={running}
            >
              {HOST_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 9, color: c.hint, marginTop: 4 }}>
              Used for both reference video and character images.
            </div>
          </div>

          {/* Runtime logs */}
          <div style={{ background: c.surface, borderRadius: 7, border: `1px solid ${c.border}` }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${c.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
              <div style={{ fontSize: 10, color: c.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Runtime logs</div>
              <div style={{ display: "flex", gap: 4 }}>
                <label style={{ fontSize: 9, color: c.hint, display: "flex", alignItems: "center", gap: 3, fontFamily: mono, cursor: "pointer" }}>
                  <input type="checkbox" checked={debugLogs} onChange={(e) => setDebugLogs(e.target.checked)} style={{ margin: 0 }} />
                  debug
                </label>
                <button onClick={copyLogs} style={{ border: `1px solid ${c.border}`, background: c.bg, borderRadius: 5, padding: "3px 8px", color: c.text, fontSize: 10, cursor: "pointer" }}>Copy</button>
                <button onClick={() => setLogs([])} style={{ border: `1px solid ${c.border}`, background: c.bg, borderRadius: 5, padding: "3px 8px", color: c.text, fontSize: 10, cursor: "pointer" }}>Clear</button>
              </div>
            </div>
            <div style={{ padding: "6px 10px", borderBottom: `1px solid ${c.border}`, display: "flex", gap: 4, alignItems: "center" }}>
              {["all", "info", "success", "warn", "error", "debug"].map((f) => (
                <button
                  key={f}
                  onClick={() => setLogFilter(f)}
                  style={{
                    border: `1px solid ${logFilter === f ? c.accent : c.border}`,
                    background: logFilter === f ? c.accent + "20" : c.bg,
                    color: logFilter === f ? c.accent : c.muted,
                    borderRadius: 4,
                    padding: "2px 6px",
                    fontSize: 9,
                    fontFamily: mono,
                    cursor: "pointer",
                    textTransform: "uppercase",
                  }}
                >
                  {f}
                </button>
              ))}
              <input
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="search…"
                style={{ flex: 1, marginLeft: 4, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 4, padding: "2px 6px", color: c.text, fontSize: 10, fontFamily: mono, outline: "none" }}
              />
            </div>
            <div
              ref={logsContainerRef}
              onScroll={handleLogsScroll}
              style={{ maxHeight: 200, overflowY: "auto", padding: "8px 10px", display: "grid", gap: 4 }}
            >
              {filteredLogs.length === 0 ? (
                <div style={{ fontSize: 10, color: c.hint }}>No logs.</div>
              ) : (
                filteredLogs.map((l) => <LogEntry key={l.id} entry={l} />)
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

          {/* Character images */}
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
                const files = Array.from(e.dataTransfer.files || []);
                handleImageFiles(files);
              }}
              style={{
                border: `1px dashed ${isImageDragOver ? c.accent : c.border}`,
                borderRadius: 7,
                padding: 12,
                textAlign: "center",
                cursor: running ? "default" : "pointer",
                background: isImageDragOver ? c.accent + "10" : c.surface,
                marginBottom: 6,
                transition: "all 0.2s ease",
              }}
            >
              <input
                ref={imgRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                multiple
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = "";
                  await handleImageFiles(files);
                }}
              />
              <div style={{ fontSize: 11, color: isImageDragOver ? c.accent : c.muted }}>
                {isImageDragOver ? "Drop images here" : "Click to select or drag & drop images"}
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
                }}>
                  {l}
                </button>
              ))}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: c.muted, cursor: running ? "default" : "pointer" }}>
              <input type="checkbox" checked={keepSound} onChange={(e) => !running && setKeepSound(e.target.checked)} disabled={running} />
              Keep original sound
            </label>
          </div>

          {/* Cost estimate */}
          <div style={{ background: c.surface, borderRadius: 7, padding: 12, border: `1px solid ${c.border}` }}>
            <div style={{ fontSize: 10, color: c.muted, marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Cost estimate</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}><span style={{ fontSize: 11, color: c.muted }}>Per video ({videoDuration}s)</span><span style={{ fontSize: 11, fontFamily: mono }}>${perVideo.toFixed(2)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 11, color: c.muted }}>This batch ({images.length})</span><span style={{ fontSize: 13, fontFamily: mono, fontWeight: 700, color: c.accent }}>${batchEst.toFixed(2)}</span></div>
          </div>

          {jobs.length === 0 ? (
            <button onClick={startBatch} disabled={running || !connected || !refVideoUrlRef.current || !!refVideoError || images.length === 0} style={{ width: "100%", padding: "12px 0", borderRadius: 7, background: running || !connected || !refVideoUrlRef.current || !!refVideoError || images.length === 0 ? c.tag : c.accent, border: "none", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Generate {images.length} video{images.length !== 1 ? "s" : ""}
            </button>
          ) : (
            <button onClick={resetBatch} style={{ width: "100%", padding: "12px 0", borderRadius: 7, background: c.surface, border: `1px solid ${c.border}`, color: c.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>New batch</button>
          )}
        </div>

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
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: col }} /><span style={{ fontSize: 10, fontFamily: mono, color: col, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span><span style={{ fontSize: 12, fontFamily: mono, fontWeight: 600 }}>{count}</span></div>
                ))}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                  {completedCount > 0 && (
                    <ZipButton
                      count={completedCount}
                      progress={zipProgress}
                      onClick={downloadAllZip}
                    />
                  )}
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
                        <JobError job={job} onRetry={() => retryJob(job.id)} onReplace={() => replaceImgRefs.current[job.id]?.click()} />
                      )}

                      <input ref={(el) => { replaceImgRefs.current[job.id] = el; }} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) replaceAndRetry(job.id, f); e.target.value = ""; }} />

                      {job.videoUrl && (
                        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <a href={proxyDownload(job)} download={safeDownloadName(job)} style={{ flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 5, background: c.accent + "18", color: c.accent, fontSize: 10, fontWeight: 600, textDecoration: "none", border: `1px solid ${c.accent}30` }}>Download</a>
                            <button onClick={() => {
                              updateJob(job.id, { status: "uploading", videoUrl: null, taskId: null, error: null });
                              submitSingleJob(job, refVideoUrlRef.current, { forceReupload: true });
                              if (!pollRef.current) startPolling();
                              log("info", `Regenerating video for ${job.imageName}`);
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
        position: "relative",
        padding: "6px 12px",
        borderRadius: 5,
        background: busy ? c.tag : c.success,
        border: "none",
        color: "#fff",
        fontSize: 11,
        fontWeight: 600,
        cursor: busy ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        overflow: "hidden",
        minWidth: 160,
      }}
    >
      {busy && (
        <span
          style={{
            position: "absolute",
            left: 0, top: 0, bottom: 0,
            width: `${percent}%`,
            background: c.accent + "55",
            transition: "width 0.2s ease",
            zIndex: 0,
          }}
        />
      )}
      <span style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 6 }}>
        {busy && (
          <span style={{ width: 10, height: 10, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
        )}
        {label}
      </span>
    </button>
  );
}

function JobError({ job, onRetry, onReplace }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, color: c.error, lineHeight: 1.4, padding: "6px 8px", background: c.error + "12", borderRadius: 4, border: `1px solid ${c.error}30`, marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
          <span style={{ flex: 1, wordBreak: "break-word" }}>{job.error || "Unknown error"}</span>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ background: "transparent", border: "none", color: c.error, fontSize: 10, cursor: "pointer", padding: 0, fontFamily: mono }}
          >
            {open ? "\u25BE" : "\u25B8"}
          </button>
        </div>
        {open && (
          <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
            <pre style={{ margin: 0, fontSize: 9, fontFamily: mono, color: c.text, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 160, overflow: "auto" }}>
              {String(job.error || "")}
            </pre>
            <button
              onClick={() => { navigator.clipboard?.writeText(String(job.error || "")); }}
              style={{ alignSelf: "flex-start", background: "transparent", border: `1px solid ${c.error}40`, color: c.error, fontSize: 9, padding: "2px 6px", borderRadius: 3, cursor: "pointer", fontFamily: mono }}
            >
              Copy error
            </button>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 5 }}>
        <button onClick={onRetry} style={{ flex: 1, padding: "7px 0", borderRadius: 5, background: c.accent, border: "none", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Retry</button>
        <button onClick={onReplace} style={{ flex: 1, padding: "7px 0", borderRadius: 5, background: c.surface, border: `1px solid ${c.border}`, color: c.text, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Replace</button>
      </div>
    </div>
  );
}
