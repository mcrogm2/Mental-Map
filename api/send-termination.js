// POST /api/send-termination
// Sends a notification email to a client when a provider ends the relationship.
// Looks up the client's email via Supabase service role key, then sends via Resend.
// RESEND_API_KEY and SUPABASE_SERVICE_ROLE_KEY must be set in Vercel env vars.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientId } = req.body || {};
  if (!clientId) {
    return res.status(400).json({ error: "Missing clientId." });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey || !supabaseUrl || !serviceKey) {
    console.error("Missing environment variables for send-termination.");
    return res.status(500).json({ error: "Server misconfiguration." });
  }

  // Look up client email using service role (bypasses RLS)
  let clientEmail;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${clientId}`, {
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
      },
    });
    if (!userRes.ok) throw new Error(`User lookup failed: ${userRes.status}`);
    const userData = await userRes.json();
    clientEmail = userData.email;
  } catch (err) {
    console.error("Failed to look up client email:", err);
    return res.status(500).json({ error: "Could not look up client." });
  }

  if (!clientEmail) {
    return res.status(404).json({ error: "Client email not found." });
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0D1024; color: #e2e8f0; border-radius: 12px;">
      <div style="font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px;">What's Therapy</div>
      <div style="font-size: 14px; color: #94a3b8; margin-bottom: 28px;">A note about your account</div>

      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.7; margin-bottom: 20px;">
        Your provider has ended your connection on What's Therapy.
      </p>

      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.7; margin-bottom: 20px;">
        Any maps your provider assigned to you that you haven't already copied to your own
        account are no longer accessible. Your personal maps are unaffected.
      </p>

      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.7; margin-bottom: 28px;">
        You can continue using What's Therapy on your own — your account and any maps
        you've saved remain exactly as you left them.
      </p>

      <a href="https://www.whatstherapy.com"
        style="display: block; background: #7F77DD; color: #fff; text-decoration: none; text-align: center; padding: 14px 20px; border-radius: 10px; font-weight: 700; font-size: 14px;">
        Go to What's Therapy
      </a>

      <p style="font-size: 12px; color: #475569; margin-top: 28px; line-height: 1.6;">
        If you have questions, please reach out to your provider directly.
      </p>
    </div>
  `;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "What's Therapy <noreply@whatstherapy.com>",
        to: [clientEmail],
        subject: "Your provider connection on What's Therapy has ended",
        html,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Resend error:", response.status, err);
      return res.status(502).json({ error: "Failed to send email." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Unexpected error sending termination email:", err);
    return res.status(500).json({ error: "Failed to send email." });
  }
}
