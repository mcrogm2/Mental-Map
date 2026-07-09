import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://sghgvbftsufklasrnrxt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnaGd2YmZ0c3Vma2xhc3Jucnh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzQ1NDMsImV4cCI6MjA5ODAxMDU0M30.V1Hxc_BEaByld3tZOjDZ-yivrxKDdcIY-nViLSK2ABo";

// ── Capture invite token BEFORE Supabase client initializes ──────────────────
// detectSessionInUrl:true causes the Supabase client to consume and clean the
// URL hash immediately on createClient() — before React mounts or any useEffect
// runs. We must read our ?invite=TOKEN query param right here, at module load
// time, before that happens.
const _params = new URLSearchParams(window.location.search);
const _inviteToken = _params.get("invite");
if (_inviteToken) {
  sessionStorage.setItem("pendingInviteToken", _inviteToken);
  // Clean the URL immediately so it doesn't confuse anything else
  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, "", cleanUrl);
}

// Export so App.jsx can read it on first render without waiting for useEffect
export const initialInviteToken = _inviteToken || sessionStorage.getItem("pendingInviteToken") || null;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
