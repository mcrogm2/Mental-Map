// POST /api/send-invite
// Sends a two-CTA invite email to a prospective client via Resend.
// Called from the Provider Portal when a provider invites a client by email.
// RESEND_API_KEY must be set in Vercel environment variables.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { to, newUserUrl, existingUserUrl } = req.body || {};

  if (!to || !newUserUrl || !existingUserUrl) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("Missing RESEND_API_KEY environment variable.");
    return res.status(500).json({ error: "Server not configured for email." });
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0D1024; color: #e2e8f0; border-radius: 12px;">
      <div style="font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px;">What's Therapy</div>
      <div style="font-size: 14px; color: #94a3b8; margin-bottom: 28px;">Your provider has invited you to connect on What's Therapy.</div>

      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.7; margin-bottom: 28px;">
        Once connected, your provider can share personalized maps with you to support your journey.
        Click the option below that applies to you:
      </p>

      <a href="${newUserUrl}"
        style="display: block; background: #7F77DD; color: #fff; text-decoration: none; text-align: center; padding: 14px 20px; border-radius: 10px; font-weight: 700; font-size: 14px; margin-bottom: 12px;">
        I'm new — create my account
      </a>

      <a href="${existingUserUrl}"
        style="display: block; background: transparent; color: #7F77DD; text-decoration: none; text-align: center; padding: 14px 20px; border-radius: 10px; font-weight: 700; font-size: 14px; border: 1px solid #7F77DD;">
        I already have an account — connect now
      </a>

      <p style="font-size: 12px; color: #475569; margin-top: 28px; line-height: 1.6;">
        This invite was sent by your provider through What's Therapy.
        If you weren't expecting this, you can safely ignore this email.
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
        to: [to],
        subject: "Your provider invited you to What's Therapy",
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
    console.error("Unexpected error sending invite:", err);
    return res.status(500).json({ error: "Failed to send email." });
  }
}
