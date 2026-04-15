export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, apiKey, ...payload } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: "Missing API key" });
  }

  try {
    let url;
    let fetchOptions;

    if (action === "upload") {
      // File upload to ephemeral_resource
      url = "https://api.piapi.ai/api/ephemeral_resource";
      fetchOptions = {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_name: payload.file_name,
          file_data: payload.file_data,
        }),
      };
    } else if (action === "create") {
      // Create a task
      url = "https://api.piapi.ai/api/v1/task";
      fetchOptions = {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload.taskBody),
      };
    } else if (action === "poll") {
      // Get task status
      url = `https://api.piapi.ai/api/v1/task/${payload.taskId}`;
      fetchOptions = {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
        },
      };
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
