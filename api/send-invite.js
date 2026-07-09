// POST /api/send-invite
// Sends a one-click invite email to a prospective client via Resend.
// Uses Supabase Admin API to generate a magic link, then embeds our invite
// token in the redirect URL as a query param that survives the auth redirect.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { to, token } = req.body || {};
  if (!to || !token) return res.status(400).json({ error: "Missing required fields." });

  const resendKey = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appUrl = "https://whatstherapy.com";

  if (!resendKey || !supabaseUrl || !serviceKey) {
    console.error("Missing environment variables.");
    return res.status(500).json({ error: "Server misconfiguration." });
  }

  // The redirect_to URL must be in Supabase's allowlist.
  // We use /?invite=TOKEN so the token survives as a query param.
  // Supabase appends #access_token=... as a hash — our query param stays intact.
  const redirectTo = `${appUrl}/?invite=${token}`;

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
      console.error("No action_link in response:", linkData);
      return res.status(502).json({ error: "Could not generate invite link." });
    }
  } catch (err) {
    console.error("Error calling Supabase generateLink:", err);
    return res.status(500).json({ error: "Could not generate invite link." });
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0D1024; color: #e2e8f0; border-radius: 12px;">
      <div style="font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px;">What's Therapy</div>
      <div style="font-size: 14px; color: #94a3b8; margin-bottom: 28px;">Your provider has invited you to connect.</div>
      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.7; margin-bottom: 28px;">
        Click the button below to get started. Works for both new and existing accounts.
      </p>
      <a href="${magicLink}"
        style="display: block; background: #7F77DD; color: #fff; text-decoration: none; text-align: center; padding: 16px 20px; border-radius: 10px; font-weight: 700; font-size: 15px; margin-bottom: 24px;">
        Accept invite &amp; get started →
      </a>
      <p style="font-size: 12px; color: #475569; line-height: 1.6;">
        This link expires in 24 hours. If you weren't expecting this, you can safely ignore it.
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
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Failed to send email." });
  }
}
