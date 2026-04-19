import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL = 8000;
const MAX_AUTO_RETRIES = 3;
const STORAGE_API_KEY = "kling_batch_api_key";
const INLINE_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;

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

const UPLOAD_PROVIDERS = [
  { id: "piapi_upload", label: "PiAPI Upload", action: "upload_piapi" },
  { id: "filebin", label: "Filebin", action: "upload_filebin" },
];

function fileToPreview(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(file);
  });
}

function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let cleaned = raw;
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch (_) {}
  // Encode spaces and special characters instead of removing them
  cleaned = cleaned.replace(/\s+/g, " ");
  if (!/^https?:\/\//i.test(cleaned)) return "";
  try {
    const url = new URL(cleaned);
    // Encode the pathname and search params
    url.pathname = url.pathname.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
    if (url.search) {
      const params = new URLSearchParams(url.search);
      const encodedParams = new URLSearchParams();
      for (const [key, value] of params) {
        encodedParams.append(encodeURIComponent(key), encodeURIComponent(value));
      }
      url.search = encodedParams.toString();
    }
    return url.toString();
  } catch (_) {
    return "";
  }
}

function getExtFromUrl(url) {
  try {
    const p = new URL(url).pathname || "";
    const m = p.toLowerCase().match(/\.([a-z0-9]{2,6})$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function sanitizeVideoFileNameFromUrl(url) {
  try {
    const p = new URL(url).pathname || "";
    const raw = decodeURIComponent(p.split("/").pop() || "motion.mp4");
    const cleaned = raw
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (/\.(mp4|mov)$/i.test(cleaned)) return cleaned;
    return `${cleaned || "motion"}.mp4`;
  } catch {
    return `motion-${Date.now()}.mp4`;
  }
}

async function validateVideoUrl(url, proxy) {
  const result = await proxy({ action: "fetch_video", url });
  if (result.error) throw new Error(result.error);
  return result.data;
}

function safeBase(name) {
  return (
    String(name || "video")
      .replace(/\.\w+$/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "video"
  );
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(src);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error("Invalid image"));
    };
    img.src = src;
  });
}

function canvasBlob(canvas, type, quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Canvas conversion failed"));
      resolve(blob);
    }, type, quality);
  });
}

async function convertImageFormat(file) {
  const img = await readImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
  const outType = isPng ? "image/jpeg" : "image/png";
  const ext = isPng ? ".jpg" : ".png";
  const blob = await canvasBlob(canvas, outType);
  return new File([blob], `${safeBase(file.name)}_v2${ext}`, { type: outType });
}

async function resizeImage(file, scale) {
  const img = await readImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
  const outType = isPng ? "image/png" : "image/jpeg";
  const ext = isPng ? ".png" : ".jpg";
  const blob = await canvasBlob(canvas, outType);
  return new File([blob], `${safeBase(file.name)}_v3${ext}`, { type: outType });
}

async function compressForUpload(file, { maxEdge = 1024, quality = 0.7 } = {}) {
  const img = await readImage(file);
  const max = maxEdge;
  let w = img.width;
  let h = img.height;
  if (w > max || h > max) {
    if (w > h) {
      h = Math.round((h * max) / w);
      w = max;
    } else {
      w = Math.round((w * max) / h);
      h = max;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await canvasBlob(canvas, "image/jpeg", quality);
  return new File([blob], `${safeBase(file.name)}.jpg`, { type: "image/jpeg" });
}

function fileToB64(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(",")[1]);
    fr.readAsDataURL(file);
  });
}

async function prepareImageInputForKling(file, { inline = false } = {}) {
  const attempts = [
    { maxEdge: 2048, quality: 0.85 },
    { maxEdge: 1600, quality: 0.8 },
    { maxEdge: 1280, quality: 0.75 },
    { maxEdge: 1024, quality: 0.7 },
  ];

  let lastCompressed = null;
  let lastRatio = null;

  for (const cfg of attempts) {
    const compressed = await compressForUpload(file, cfg);
    const img = await readImage(compressed);
    const ratio = img.width / img.height;
    lastCompressed = compressed;
    lastRatio = ratio;

    if (ratio < 1 / 2.5 || ratio > 2.5) continue;
    if (compressed.size > 10 * 1024 * 1024) continue;
    if (inline && compressed.size > INLINE_IMAGE_MAX_BYTES) continue;

    const base64 = await fileToB64(compressed); // raw base64, no data: prefix
    return { base64, compressed, ratio };
  }

  if (lastRatio != null && (lastRatio < 1 / 2.5 || lastRatio > 2.5)) {
    throw new Error("Image aspect ratio must be between 1:2.5 and 2.5:1");
  }

  if (inline) {
    throw new Error("Image too large for inline fallback mode. Use URL upload path or reduce image size.");
  }

  if (lastCompressed?.size > 10 * 1024 * 1024) {
    throw new Error("Image exceeds 10MB limit after processing");
  }

  throw new Error("Unable to prepare image for Kling input");
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

function OnlineBadge({ ok }) {
  const color = ok === true ? c.success : ok === false ? c.error : c.warn;
  const txt = ok === true ? "online" : ok === false ? "offline" : "unknown";
  return <span style={{ fontSize: 9, color, fontFamily: mono, textTransform: "uppercase" }}>{txt}</span>;
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_API_KEY) || "");
  const [connected, setConnected] = useState(() => Boolean(localStorage.getItem(STORAGE_API_KEY)));

  const [refVideoName, setRefVideoName] = useState("");
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
  const [serviceStatus, setServiceStatus] = useState({ checking: false, data: null, lastChecked: null });

  const imgRef = useRef();
  const replaceImgRefs = useRef({});
  const jobsRef = useRef([]);
  const pollRef = useRef(null);
  const refVideoUrlRef = useRef("");
  const taskVideoUrlRef = useRef("");
  const probingRef = useRef(false);

  const rate = mode === "std" ? 0.065 : 0.104;
  const perVideo = rate * videoDuration;
  const batchEst = perVideo * images.length;

  const log = useCallback((type, message) => {
    setLogs((prev) => [...prev.slice(-199), { id: Date.now() + Math.random(), ts: new Date().toLocaleTimeString(), type, message }]);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_API_KEY, apiKey || "");
  }, [apiKey]);

  const handleImages = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    const items = await Promise.all(files.map(async (f) => ({ name: f.name, file: f, preview: await fileToPreview(f) })));
    setImages((p) => [...p, ...items]);
    log("info", `Added ${files.length} image(s)`);
    e.target.value = "";
  }, [log]);

  const removeImage = (i) => setImages((p) => p.filter((_, idx) => idx !== i));

  async function proxy(body) {
    const action = body?.action;
    const needsApiKey = action === "create" || action === "poll" || action === "upload" || action === "upload_piapi";
    const r = await fetch("/api/piapi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(needsApiKey ? { apiKey, ...body } : body),
    });
    const txt = await r.text();
    try {
      return JSON.parse(txt);
    } catch (_) {
      return { error: txt || "Invalid response" };
    }
  }

  function extractUploadUrl(resp) {
    return (
      resp?.downloadLinkEncoded ||
      resp?.downloadLink ||
      resp?.data?.downloadLinkEncoded ||
      resp?.data?.downloadLink ||
      resp?.data?.url ||
      resp?.url ||
      resp?.link ||
      resp?.data?.link ||
      resp?.data?.file?.url ||
      resp?.file?.url ||
      ""
    );
  }

  async function uploadFile(file, jobId) {
    const file_data = await fileToB64(file);
    const providers = UPLOAD_PROVIDERS;

    let lastError = "Upload failed";
    for (const provider of providers) {
      try {
        const data = await proxy({ action: provider.action, file_name: file.name, file_type: file.type, file_data });
        const url = extractUploadUrl(data);
        if (!url) {
          const details = data?.raw ? (typeof data.raw === "string" ? data.raw : JSON.stringify(data.raw)) : "";
          throw new Error(data?.message || data?.error || `No URL from ${provider.id}${details ? `: ${details.slice(0, 180)}` : ""}`);
        }
        log("success", `Job #${jobId + 1}: uploaded via ${provider.id} (${url.slice(0, 90)}${url.length > 90 ? "..." : ""})`);
        return { url, provider: provider.id };
      } catch (err) {
        lastError = err.message;
        log("warn", `Job #${jobId + 1}: ${provider.id} failed (${err.message})`);
      }
    }
    throw new Error(lastError);
  }

  async function submitJob(imageUrl, videoUrl) {
    const d = await proxy({
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
    throw new Error(d?.message || d?.error?.message || "Submit failed");
  }

  async function checkJob(taskId) {
    const d = await proxy({ action: "poll", taskId });
    return d?.data;
  }

async function prepareVideoUrlForTask(rawVideoUrl) {
    const normalized = normalizeUrl(rawVideoUrl);
    if (!normalized) throw new Error("Invalid video URL. Use full http(s) link.");

    const ext = getExtFromUrl(normalized);
    if (ext && !["mp4", "mov"].includes(ext)) {
      throw new Error("Motion video must be .mp4 or .mov");
    }

    // Validate that the URL returns video content
    const validated = await validateVideoUrl(normalized, proxy);

    return { url: validated.url, provider: "direct_video_url" };
  }

  async function runProbe() {
    if (probingRef.current) return;
    probingRef.current = true;
    setServiceStatus((p) => ({ ...p, checking: true }));

    async function pingDomain(url, timeoutMs = 6000) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        await fetch(url, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
          signal: ctl.signal,
        });
        return { ok: true, status: null, error: null };
      } catch (err) {
        return { ok: false, status: null, error: err?.message || "Network error" };
      } finally {
        clearTimeout(t);
      }
    }

    try {
      const [piapi, filebin] = await Promise.all([
        pingDomain("https://api.piapi.ai/"),
        pingDomain("https://filebin.net/"),
      ]);

      setServiceStatus({
        checking: false,
        data: {
          piapi,
          filebin,
        },
        lastChecked: Date.now(),
      });
      log("success", `Service probe done (piapi: ${piapi.ok ? "online" : "offline"}, filebin: ${filebin.ok ? "online" : "offline"})`);
    } catch (err) {
      setServiceStatus({ checking: false, data: null, lastChecked: Date.now() });
      log("error", `Probe failed: ${err.message}`);
    } finally {
      probingRef.current = false;
    }
  }

  useEffect(() => {
    log("info", "Auto-probe on startup");
    runProbe();
    // Intentionally run once on initial page load/refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function submitSingleJob(job, videoUrl, fileOverride, options = {}) {
    try {
      updateJob(job.id, { status: "uploading", error: null });
      const fileToUpload = fileOverride || job.file;
      const forceInline = Boolean(options?.forceInline);

      if (forceInline) {
        const inlinePrepared = await prepareImageInputForKling(fileToUpload, { inline: true });
        updateJob(job.id, { imageUrl: "base64:inline", uploadProviderUsed: "base64-direct" });
        const taskId = await submitJob(inlinePrepared.base64, videoUrl);
        updateJob(job.id, { status: "processing", taskId, error: null, videoUrl: null });
        log("info", `Job #${job.id + 1}: task ${taskId} submitted (image input: forced base64 retry)`);
        return true;
      }

      // Primary path: URL mode (smaller request payload).
      const prepared = await prepareImageInputForKling(fileToUpload, { inline: false });
      let primaryError = null;
      try {
        const { url, provider } = await uploadFile(prepared.compressed, job.id);
        updateJob(job.id, { imageUrl: url, uploadProviderUsed: provider });
        const taskId = await submitJob(url, videoUrl);
        updateJob(job.id, { status: "processing", taskId, error: null, videoUrl: null });
        log("info", `Job #${job.id + 1}: task ${taskId} submitted (image input: url)`);
        return true;
      } catch (err) {
        primaryError = err;
      }

      // Fallback path: inline base64 only for decode/fetch-style URL issues.
      if (!isImageDecodeFetchError(primaryError?.message)) {
        throw primaryError;
      }

      log("warn", `Job #${job.id + 1}: URL input failed, trying inline base64 fallback`);
      const inlinePrepared = await prepareImageInputForKling(fileToUpload, { inline: true });
      updateJob(job.id, { imageUrl: "base64:inline", uploadProviderUsed: "base64-direct" });
      const taskId = await submitJob(inlinePrepared.base64, videoUrl);
      updateJob(job.id, { status: "processing", taskId, error: null, videoUrl: null });
      log("info", `Job #${job.id + 1}: task ${taskId} submitted (image input: base64 fallback)`);
      return true;
    } catch (err) {
      updateJob(job.id, { status: "failed", error: err.message });
      log("error", `Job #${job.id + 1}: ${err.message}`);
      return false;
    }
  }

  async function autoRetry(job, videoUrl, options = {}) {
    const retries = (job.retries || 0) + 1;
    if (retries > MAX_AUTO_RETRIES) {
      updateJob(job.id, { status: "failed", retries });
      return;
    }
    updateJob(job.id, { status: "retrying", retries, error: null });
    await new Promise((r) => setTimeout(r, 1800));
    let f = job.file;
    try {
      if (retries === 2) f = await convertImageFormat(job.file);
      if (retries === 3) f = await resizeImage(job.file, 0.95);
    } catch (_) {}
    await submitSingleJob(job, videoUrl, f, options);
  }

  function parseReference(urlInput) {
    const cleaned = normalizeUrl(urlInput);
    if (!urlInput.trim()) {
      setRefVideoError("");
      refVideoUrlRef.current = "";
      return;
    }
    if (!cleaned) {
      setRefVideoError("Invalid URL. Use full http(s) link.");
      refVideoUrlRef.current = "";
      return;
    }
    setRefVideoError("");
    refVideoUrlRef.current = cleaned;

    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      if (v.duration && !Number.isNaN(v.duration)) setVideoDuration(Math.ceil(v.duration));
    };
    v.src = cleaned;
  }

  async function startBatch() {
    if (!apiKey || !refVideoUrlRef.current || images.length === 0 || refVideoError) return;
    if (!serviceStatus.data) await runProbe();

    let taskVideoUrl = refVideoUrlRef.current;
    try {
      const preparedVideo = await prepareVideoUrlForTask(refVideoUrlRef.current);
      taskVideoUrl = preparedVideo.url;
      taskVideoUrlRef.current = preparedVideo.url;
      log("success", `Reference video uploaded via ${preparedVideo.provider}`);
    } catch (err) {
      setRefVideoError(err.message || "Failed to prepare reference video");
      log("error", `Reference video prep failed: ${err.message}`);
      return;
    }

    const initial = images.map((img, i) => ({
      id: i,
      imageName: img.name,
      file: img.file,
      preview: img.preview,
      status: "uploading",
      taskId: null,
      videoUrl: null,
      imageUrl: null,
      uploadProviderUsed: null,
      error: null,
      retries: 0,
    }));
    jobsRef.current = initial;
    setJobs([...initial]);
    setRunning(true);
    setBatchDone(false);

    const vurl = taskVideoUrl;
    await Promise.all(initial.map((job) => submitSingleJob(job, vurl)));
    startPolling();
  }

  async function retryJob(id) {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    updateJob(id, { retries: 0 });
    if (batchDone) {
      setBatchDone(false);
      setRunning(true);
    }
    const activeVideoUrl = taskVideoUrlRef.current || refVideoUrlRef.current;
    await submitSingleJob(job, activeVideoUrl);
    if (!pollRef.current) startPolling();
  }

  async function replaceAndRetry(id, newFile) {
    const preview = await fileToPreview(newFile);
    updateJob(id, { file: newFile, imageName: newFile.name, preview, status: "uploading", imageUrl: null, retries: 0, error: null });
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    if (batchDone) {
      setBatchDone(false);
      setRunning(true);
    }
    const activeVideoUrl = taskVideoUrlRef.current || refVideoUrlRef.current;
    await submitSingleJob(job, activeVideoUrl);
    if (!pollRef.current) startPolling();
  }

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const active = jobsRef.current.filter((j) => j.status === "processing");
      if (active.length === 0) {
        const waiting = jobsRef.current.some((j) => j.status === "uploading" || j.status === "retrying");
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
          } else if (data?.status === "failed") {
            const err = data?.error?.raw_message || data?.error?.message || "Generation failed";
            updateJob(job.id, { error: err });
            const current = jobsRef.current.find((j) => j.id === job.id);
            const activeVideoUrl = taskVideoUrlRef.current || refVideoUrlRef.current;
            if (isImageDecodeFetchError(err) && (current?.retries || 0) < MAX_AUTO_RETRIES) {
              log("warn", `Job #${job.id + 1}: decode/fetch error detected, retrying with inline base64`);
              await autoRetry(current, activeVideoUrl, { forceInline: true });
            } else if (isContentFilterError(err) && (current?.retries || 0) < MAX_AUTO_RETRIES) {
              await autoRetry(current, activeVideoUrl);
            } else {
              updateJob(job.id, { status: "failed" });
            }
          }
        } catch (_) {}
      }
    }, POLL_INTERVAL);
  }

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function resetBatch() {
    setJobs([]);
    setBatchDone(false);
    setImages([]);
    setRefVideoName("");
    setRefVideoError("");
    setVideoDuration(10);
    refVideoUrlRef.current = "";
    taskVideoUrlRef.current = "";
  }

  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const processingCount = jobs.filter((j) => ["processing", "uploading", "retrying"].includes(j.status)).length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const spent = completedCount * perVideo;

  const safeDownloadName = (job) => `${safeBase(job.imageName)}.mp4`;
  const proxyDownload = (job) => `/api/piapi?action=download_proxy&url=${encodeURIComponent(job.videoUrl)}&filename=${encodeURIComponent(safeDownloadName(job))}`;

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
      `}</style>

      <div style={{ padding: "16px 24px", borderBottom: `1px solid ${c.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: c.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#fff" }}>K</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Kling Batch Motion Control</div>
            <div style={{ fontSize: 10, color: c.hint, fontFamily: mono }}>v2.6 · PiAPI · fallback upload · runtime logs</div>
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
                onClick={() => !running && document.getElementById('videoFileInput')?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!running) setIsVideoDragOver(true); }}
                onDragEnter={(e) => { e.preventDefault(); if (!running) setIsVideoDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); if (!running) setIsVideoDragOver(false); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setIsVideoDragOver(false);
                  if (running) return;
                  const file = e.dataTransfer.files[0];
                  if (!file || !file.type.startsWith('video/')) return;
                  try {
                    setRefVideoError("");
                    log("info", `Uploading video file: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
                    const base64 = await fileToB64(file);
                    const result = await proxy({
                      action: "upload_piapi",
                      file_name: file.name,
                      file_type: file.type,
                      file_data: base64,
                    });
                    const url = extractUploadUrl(result);
                    if (!url) throw new Error("Upload failed - no URL returned");
                    setRefVideoFileName(file.name);
                    setRefVideoName(file.name);
                    refVideoUrlRef.current = url;
                    log("success", `Video uploaded: ${file.name}`);
                  } catch (err) {
                    setRefVideoError(err.message);
                    log("error", `Video upload failed: ${err.message}`);
                  }
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
                  transition: "all 0.2s ease"
                }}
              >
                {isVideoDragOver ? "Drop video file here" : "Click to select or drag & drop video file (MP4/MOV)"}
              </div>
              <input id="videoFileInput" type="file" accept="video/mp4,video/mov" onChange={async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                  setRefVideoError("");
                  log("info", `Uploading video file: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
                  const base64 = await fileToB64(file);
                  const result = await proxy({
                    action: "upload_piapi",
                    file_name: file.name,
                    file_type: file.type,
                    file_data: base64,
                  });
                  const url = extractUploadUrl(result);
                  if (!url) throw new Error("Upload failed - no URL returned");
                  setRefVideoFileName(file.name);
                  setRefVideoName(file.name);
                  refVideoUrlRef.current = url;
                  log("success", `Video uploaded: ${file.name}`);
                } catch (err) {
                  setRefVideoError(err.message);
                  log("error", `Video upload failed: ${err.message}`);
                }
                e.target.value = "";
              }} disabled={running} style={{ display: 'none' }} />
            </div>
          </div>





          <div style={{ background: c.surface, borderRadius: 7, border: `1px solid ${c.border}` }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${c.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 10, color: c.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Runtime logs</div>
              <button onClick={() => setLogs([])} style={{ border: `1px solid ${c.border}`, background: c.bg, borderRadius: 5, padding: "3px 8px", color: c.text, fontSize: 10, cursor: "pointer" }}>Clear</button>
            </div>
            <div style={{ maxHeight: 150, overflowY: "auto", padding: "8px 10px", display: "grid", gap: 4 }}>
              {logs.length === 0 ? <div style={{ fontSize: 10, color: c.hint }}>No logs yet.</div> : logs.map((l) => (
                <div key={l.id} style={{ fontSize: 10, fontFamily: mono, color: l.type === "error" ? c.error : l.type === "warn" ? c.warn : l.type === "success" ? c.success : c.muted }}>[{l.ts}] {l.message}</div>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>Character images ({images.length})</div>
            <div
              onClick={() => !running && imgRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); if (!running) setIsImageDragOver(true); }}
              onDragEnter={(e) => { e.preventDefault(); if (!running) setIsImageDragOver(true); }}
              onDragLeave={(e) => { e.preventDefault(); if (!running) setIsImageDragOver(false); }}
              onDrop={async (e) => {
                e.preventDefault();
                setIsImageDragOver(false);
                if (running) return;
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                if (files.length === 0) return;
                const items = await Promise.all(files.map(async (f) => ({ name: f.name, file: f, preview: await fileToPreview(f) })));
                setImages((p) => [...p, ...items]);
                log("info", `Added ${files.length} image(s) via drag & drop`);
              }}
              style={{
                border: `1px dashed ${isImageDragOver ? c.accent : c.border}`,
                borderRadius: 7,
                padding: 12,
                textAlign: "center",
                cursor: running ? "default" : "pointer",
                background: isImageDragOver ? c.accent + "10" : c.surface,
                marginBottom: 6,
                transition: "all 0.2s ease"
              }}
            >
              <input ref={imgRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handleImages} />
              <div style={{ fontSize: 11, color: isImageDragOver ? c.accent : c.muted }}>
                {isImageDragOver ? "Drop images here" : "Click to select or drag & drop images"}
              </div>
            </div>
            {images.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{images.map((img, i) => (
              <div key={i} style={{ position: "relative", width: 44, height: 44 }}>
                <img src={img.preview} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 5, border: `1px solid ${c.border}` }} />
                {!running && <button onClick={(e) => { e.stopPropagation(); removeImage(i); }} style={{ position: "absolute", top: -3, right: -3, width: 14, height: 14, borderRadius: "50%", background: c.error, border: "none", color: "#fff", fontSize: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>}
              </div>
            ))}</div>}
          </div>

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
          </div>

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
              <div>Paste a reference video URL and upload character images to start</div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 14, marginBottom: 16, padding: "10px 14px", background: c.surface, borderRadius: 7, border: `1px solid ${c.border}`, alignItems: "center", flexWrap: "wrap" }}>
                {[[c.success, "Done", completedCount], [c.accent, "Running", processingCount], [c.error, "Failed", failedCount]].map(([col, label, count]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: col }} /><span style={{ fontSize: 10, fontFamily: mono, color: col, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span><span style={{ fontSize: 12, fontFamily: mono, fontWeight: 600 }}>{count}</span></div>
                ))}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                  {completedCount > 0 && completedCount === jobs.length && (
                    <button onClick={() => {
                      const completedJobs = jobs.filter(j => j.status === "completed");
                      completedJobs.forEach((job, i) => {
                        setTimeout(() => {
                          const link = document.createElement('a');
                          link.href = proxyDownload(job);
                          link.download = safeDownloadName(job);
                          document.body.appendChild(link);
                          link.click();
                          document.body.removeChild(link);
                        }, i * 500); // Stagger downloads
                      });
                      log("info", `Downloading ${completedJobs.length} completed videos`);
                    }} style={{ padding: "6px 12px", borderRadius: 5, background: c.success, border: "none", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                      Download All ({completedCount})
                    </button>
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
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 10, color: c.error, lineHeight: 1.4, padding: "6px 8px", background: c.error + "12", borderRadius: 4, border: `1px solid ${c.error}30`, marginBottom: 8 }}>{job.error || "Unknown error"}</div>
                          <div style={{ display: "flex", gap: 5 }}>
                            <button onClick={() => retryJob(job.id)} style={{ flex: 1, padding: "7px 0", borderRadius: 5, background: c.accent, border: "none", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Retry</button>
                            <button onClick={() => replaceImgRefs.current[job.id]?.click()} style={{ flex: 1, padding: "7px 0", borderRadius: 5, background: c.surface, border: `1px solid ${c.border}`, color: c.text, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Replace</button>
                            <input ref={(el) => { replaceImgRefs.current[job.id] = el; }} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files[0]; if (f) replaceAndRetry(job.id, f); e.target.value = ""; }} />
                          </div>
                        </div>
                      )}

                      {job.videoUrl && (
                        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                          <a href={proxyDownload(job)} download={safeDownloadName(job)} style={{ display: "block", textAlign: "center", padding: "7px 0", borderRadius: 5, background: c.accent + "18", color: c.accent, fontSize: 11, fontWeight: 600, textDecoration: "none", border: `1px solid ${c.accent}30` }}>Download MP4</a>
                          <a href={job.videoUrl} download={safeDownloadName(job)} target="_blank" rel="noreferrer" style={{ textAlign: "center", fontSize: 9, color: c.hint, textDecoration: "none" }}>Fallback direct link</a>
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
    </div>
  );
}
