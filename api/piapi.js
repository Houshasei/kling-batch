export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

async function readAsJsonOrText(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch (_) {
    return { json: null, text };
  }
}

function normalizeFilebinPayload(payload, bin, filename, mime, size) {
  const encodedBin = encodeURIComponent(String(bin));
  const encodedName = encodeURIComponent(String(filename));
  const viewUrl = `https://filebin.net/${encodedBin}/${encodedName}`;
  const downloadUrl = `${viewUrl}?download=1`;
  const source = payload && typeof payload === "object" ? payload : {};

  return {
    fileName: source.fileName || source.filename || filename,
    downloadLink: source.downloadLink || source.url || downloadUrl,
    downloadLinkEncoded: source.downloadLinkEncoded || source.download_link_encoded || source.encodedUrl || downloadUrl,
    viewLink: viewUrl,
    size: source.size ?? size,
    type: source.type || mime,
    uploadedTo: source.uploadedTo || `bin:${bin}`,
    bin,
  };
}

async function resolveFilebinDirectUrl(filebinUrl) {
  try {
    const r = await fetch(filebinUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*" },
    });

    const location = r.headers.get("location") || "";
    if (r.status >= 300 && r.status < 400 && /^https:\/\/storage\.filebin\.net\//i.test(location)) {
      return location;
    }
  } catch (_) {
    // Ignore resolver errors; keep fallback URL.
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { action, url, filename } = req.query || {};

    if (action !== "download_proxy") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!url) {
      return res.status(400).json({ error: "Missing url" });
    }

    try {
      const r = await fetch(String(url));
      if (!r.ok) {
        return res.status(r.status).json({ error: "Failed to fetch remote file" });
      }

      const contentType = r.headers.get("content-type") || "application/octet-stream";
      const safeName = String(filename || "video-download.mp4").replace(/[\r\n"]/g, "");
      const buffer = Buffer.from(await r.arrayBuffer());

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      return res.status(200).send(buffer);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, apiKey, ...payload } = req.body;

  const needsApiKey = ["create", "poll", "upload_piapi", "upload_temp_sh"].includes(action);
  if (needsApiKey && !apiKey) {
    return res.status(400).json({ error: "Missing API key" });
  }

  function isReachableStatus(status) {
    return status >= 200 && status < 500;
  }

  try {
    if (action === "create") {
      const r = await fetch("https://api.piapi.ai/api/v1/task", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload.taskBody),
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    } else if (action === "poll") {
      const r = await fetch("https://api.piapi.ai/api/v1/task/" + payload.taskId, {
        method: "GET",
        headers: { "x-api-key": apiKey },
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    } else if (action === "upload_piapi") {
      if (!payload.file_name || !payload.file_data) {
        return res.status(400).json({ error: "Missing file_name or file_data" });
      }

      const r = await fetch("https://upload.theapi.app/api/ephemeral_resource", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_name: String(payload.file_name),
          file_data: String(payload.file_data),
        }),
      });

      const { json, text } = await readAsJsonOrText(r);
      if (!r.ok) {
        return res.status(r.status).json({
          error: json?.message || json?.error || text || "piapi upload failed",
          raw: json || text,
        });
      }

      const uploadedUrl =
        json?.data?.url ||
        json?.url ||
        "";

      if (!uploadedUrl) {
        return res.status(502).json({
          error: "piapi upload returned invalid response",
          raw: json || text,
        });
      }

      return res.status(200).json({
        data: {
          fileName: String(payload.file_name),
          downloadLink: uploadedUrl,
          downloadLinkEncoded: uploadedUrl,
          uploadedTo: "piapi_ephemeral_resource",
          type: String(payload.file_type || "application/octet-stream"),
        },
        raw: json || text,
      });
    } else if (action === "upload_temp_sh") {
      if (!payload.file_name || !payload.file_data) {
        return res.status(400).json({ error: "Missing file_name or file_data" });
      }

      const binData = Buffer.from(String(payload.file_data), "base64");
      const uploadUrl = `https://temp.sh/upload`;

      const form = new FormData();
      form.append("file", new Blob([binData], { type: payload.file_type || "application/octet-stream" }), payload.file_name);

      const r = await fetch(uploadUrl, {
        method: "POST",
        body: form,
      });

      const { json, text } = await readAsJsonOrText(r);
      if (!r.ok) {
        return res.status(r.status).json({
          error: json?.error || json?.message || text || "temp.sh upload failed",
          raw: json || text,
        });
      }

      // temp.sh returns the URL directly in the response body
      const uploadedUrl = (text || "").trim();
      if (!uploadedUrl || !uploadedUrl.startsWith("https://temp.sh/")) {
        return res.status(502).json({
          error: "temp.sh returned invalid URL",
          raw: text,
        });
      }

      return res.status(200).json({
        data: {
          fileName: String(payload.file_name),
          downloadLink: uploadedUrl,
          downloadLinkEncoded: uploadedUrl,
          uploadedTo: "temp_sh",
          type: String(payload.file_type || "application/octet-stream"),
        },
        raw: text,
      });
    } else if (action === "upload_filebin") {
      if (!payload.file_name || !payload.file_data) {
        return res.status(400).json({ error: "Missing file_name or file_data" });
      }

      const binData = Buffer.from(String(payload.file_data), "base64");
      const mime = String(payload.file_type || "application/octet-stream");
      const fileName = String(payload.file_name);
      const filebinName = payload.filebin_name || `kling-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const uploadUrl = `https://filebin.net/${encodeURIComponent(filebinName)}/${encodeURIComponent(fileName)}`;
      const r = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": mime },
        body: binData,
      });

      const { json, text } = await readAsJsonOrText(r);
      const normalized = normalizeFilebinPayload(json, filebinName, fileName, mime, binData.length);

      if (!r.ok) {
        return res.status(r.status).json({
          error: json?.error || json?.message || text || "filebin upload failed",
          raw: json || text,
        });
      }

      if (!normalized?.downloadLink && !normalized?.downloadLinkEncoded) {
        return res.status(502).json({
          error: "filebin returned invalid response",
          raw: json || text,
        });
      }

      const directUrl = await resolveFilebinDirectUrl(normalized.viewLink || normalized.downloadLinkEncoded || normalized.downloadLink);
      if (directUrl) {
        normalized.downloadLink = directUrl;
        normalized.downloadLinkEncoded = directUrl;
      }

      return res.status(200).json({ data: normalized, raw: json || text });
    } else if (action === "fetch_video") {
      if (!payload.url) {
        return res.status(400).json({ error: "Missing url" });
      }

      const url = String(payload.url);
      const r = await fetch(url, { method: "HEAD" });
      if (!r.ok) throw new Error(`Failed to fetch video URL (${r.status})`);
      const contentType = (r.headers.get("content-type") || "").toLowerCase();
      if (contentType && !contentType.includes("video")) {
        throw new Error(`Video URL did not return a video content-type (${contentType})`);
      }
      return res.status(200).json({
        data: {
          url: url,
          contentType: contentType || "video/mp4",
        },
      });
    } else if (action === "probe") {
      const checks = {
        piapi: { ok: false, status: null, error: null },
        filebin: { ok: false, status: null, error: null },
      };

      try {
        const r = await fetch("https://api.piapi.ai/", { method: "GET" });
        checks.piapi.status = r.status;
        checks.piapi.ok = isReachableStatus(r.status);
      } catch (err) {
        checks.piapi.error = err.message;
      }

      try {
        const r = await fetch("https://filebin.net/", { method: "GET" });
        checks.filebin.status = r.status;
        checks.filebin.ok = isReachableStatus(r.status);
      } catch (err) {
        checks.filebin.error = err.message;
      }

      return res.status(200).json({ data: checks });
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
