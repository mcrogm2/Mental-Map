// POST /api/send-invite
// Sends a one-click invite email to a prospective client via Resend.
// Uses Supabase Admin API to generate a magic link for the client's email
// so they only need to click ONE button — no form, no second email.
// Works for both new users (creates account) and existing users (signs in).
// Required env vars: RESEND_API_KEY, VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { to, token } = req.body || {};

  if (!to || !token) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!resendKey || !supabaseUrl || !serviceKey) {
    console.error("Missing environment variables for send-invite.");
    return res.status(500).json({ error: "Server misconfiguration." });
  }

  // ── Generate a magic link for the client's email ──────────────────────────
  // This works for both new and existing users — Supabase handles both cases.
  // The redirect URL includes the invite token so the app can connect the
  // provider-client relationship automatically after sign-in.
  const redirectTo = `${process.env.VITE_APP_URL || "https://www.whatstherapy.com"}/invite/${token}`;

  let magicLink;
  try {
    const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "magiclink",
        email: to,
        options: { redirect_to: redirectTo },
      }),
    });

    if (!linkRes.ok) {
      const err = await linkRes.text();
      console.error("Supabase generateLink error:", linkRes.status, err);
      return res.status(502).json({ error: "Could not generate invite link." });
    }

    const linkData = await linkRes.json();
    magicLink = linkData.action_link;

    if (!magicLink) {
      console.error("No action_link in Supabase response:", linkData);
      return res.status(502).json({ error: "Could not generate invite link." });
    }
  } catch (err) {
    console.error("Error calling Supabase generateLink:", err);
    return res.status(500).json({ error: "Could not generate invite link." });
  }

  // ── Send the email via Resend ─────────────────────────────────────────────
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0D1024; color: #e2e8f0; border-radius: 12px;">
      <div style="font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px;">What's Therapy</div>
      <div style="font-size: 14px; color: #94a3b8; margin-bottom: 28px;">Your provider has invited you to connect.</div>

      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.7; margin-bottom: 28px;">
        Click the button below to get started. If you already have a What's Therapy account,
        clicking this link will sign you in and connect you with your provider automatically.
        If you're new, it will create your account in one step.
      </p>

      <a href="${magicLink}"
        style="display: block; background: #7F77DD; color: #fff; text-decoration: none; text-align: center; padding: 16px 20px; border-radius: 10px; font-weight: 700; font-size: 15px; margin-bottom: 24px;">
        Accept invite &amp; get started →
      </a>

      <p style="font-size: 12px; color: #475569; line-height: 1.6;">
        This link expires in 24 hours. If you weren't expecting this invite, you can safely ignore this email.
      </p>
    </div>
  `;

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "What's Therapy <noreply@whatstherapy.com>",
        to: [to],
        subject: "Your provider invited you to What's Therapy",
        html,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error("Resend error:", emailRes.status, err);
      return res.status(502).json({ error: "Failed to send email." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Unexpected error sending invite:", err);
    return res.status(500).json({ error: "Failed to send email." });
  }
}
