import { createClient } from "@supabase/supabase-js";

// These are the PUBLIC project URL and anon/public API key — safe to ship in
// frontend code. Per-row access control is enforced by Row Level Security
// policies on the database side, not by keeping this key secret.
const SUPABASE_URL = "https://sghgvbftsufklasrnrxt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnaGd2YmZ0c3Vma2xhc3Jucnh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzQ1NDMsImV4cCI6MjA5ODAxMDU0M30.V1Hxc_BEaByld3tZOjDZ-yivrxKDdcIY-nViLSK2ABo";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Persist the session in the browser (localStorage) so a signed-in
    // person stays signed in across page reloads, and auto-refresh the
    // access token in the background so long sessions don't silently expire
    // mid-use.
    persistSession: true,
    autoRefreshToken: true,
    // Supabase's client automatically detects and consumes the auth tokens
    // that appear in the URL after a magic-link redirect (the "implicit
    // flow" — matches our default email template / URL configuration, no
    // separate token-exchange step needed on our end).
    detectSessionInUrl: true,
  },
});
