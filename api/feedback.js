// POST /api/feedback
// Receives a feedback/suggestion submission from the Mental Map app and
// writes it to Airtable as a new record. The Airtable Personal Access Token
// and Base ID live only in Vercel environment variables (AIRTABLE_TOKEN,
// AIRTABLE_BASE_ID) — they are never sent to the browser.

const VALID_TYPES = ["Suggest a new topic", "Suggest a resource", "Something's broken", "Wording or clarity", "This was helpful!"];
const TABLE_NAME = "Feedback"; // change here if you named your Airtable table differently

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, feedbackType, feedback } = req.body || {};

  // ── Validate input ────────────────────────────────────────────────────
  if (typeof feedback !== "string" || feedback.trim().length === 0) {
    return res.status(400).json({ error: "Feedback text is required." });
  }
  if (feedback.length > 2000) {
    return res.status(400).json({ error: "Feedback is too long (max 2000 characters)." });
  }
  if (!VALID_TYPES.includes(feedbackType)) {
    return res.status(400).json({ error: "Invalid feedback type." });
  }
  const nodeValue = typeof node === "string" && node.trim().length > 0 ? node.trim() : "General";

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    // Misconfiguration on our end — don't leak details, just fail clearly.
    console.error("Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID environment variable.");
    return res.status(500).json({ error: "Server is not configured to accept feedback yet." });
  }

  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(TABLE_NAME)}`;

  try {
    const airtableRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: [
          {
            fields: {
              "Node": nodeValue,
              "Feedback Type": feedbackType,
              "Feedback": feedback.trim(),
              "Status": "New",
            },
          },
        ],
      }),
    });

    if (!airtableRes.ok) {
      const errBody = await airtableRes.text();
      console.error("Airtable API error:", airtableRes.status, errBody);
      return res.status(502).json({ error: "Could not save feedback right now. Please try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Unexpected error submitting feedback:", err);
    return res.status(500).json({ error: "Could not save feedback right now. Please try again." });
  }
}
