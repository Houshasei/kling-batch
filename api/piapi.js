export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, apiKey, ...payload } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: "Missing API key" });
  }

  try {
    if (action === "upload") {
      // Upload to PiAPI ephemeral_resource (base64 JSON)
      const r = await fetch("https://api.piapi.ai/api/ephemeral_resource", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ file_name: payload.file_name, file_data: payload.file_data }),
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    } else if (action === "create") {
      const r = await fetch("https://api.piapi.ai/api/v1/task", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload.taskBody),
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    } else if (action === "poll") {
      const r = await fetch(`https://api.piapi.ai/api/v1/task/${payload.taskId}`, {
        method: "GET",
        headers: { "x-api-key": apiKey },
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}