// Halomanage — send-notifications Edge Function
// Ref: ARCHITECTURE.md "Notifications" — in-app notifications are fully
// Supabase-native (a row + Realtime); email/SMS/push need an outbound
// provider, which is exactly what does NOT belong in a client-callable RPC
// (it needs a provider API key, which must stay server-side).
//
// Intended to run on a short Cron schedule (e.g. every 1–2 minutes) via
// Supabase Cron invoking this function, not to be called by the client
// directly. It looks for notifications that have an enabled non-in_app
// channel preference and no delivery attempt yet, sends each one through
// Resend, and records the delivery attempt either way.
//
// Needs two secrets set on the deployed project (never committed —
// `supabase secrets set RESEND_API_KEY=... EMAIL_FROM_ADDRESS=...`; see
// supabase/functions/README.md):
//   RESEND_API_KEY   — from resend.com/api-keys
//   EMAIL_FROM_ADDRESS — must be on a domain verified in Resend (Domains
//     tab); Halomanage's own auth-flow invite emails are a separate
//     concern, configured as Supabase Auth's custom SMTP provider in the
//     dashboard rather than in this function — see the README.

import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { jsonResponse } from "../_shared/cors.ts";
import { renderEmailShell } from "../_shared/email-shell.mjs";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendEmail(to: string, subject: string, body: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set — skipping email send (dev mode)");
    return { ok: true, skipped: true };
  }
  const from = Deno.env.get("EMAIL_FROM_ADDRESS") || "Halomanage <notifications@myhalomanage.com>";
  // body is free-text pulled from the notifications table (leave decisions,
  // document expiry, etc.) — escaped before it goes anywhere near HTML, and
  // sent as its own <p> rather than folded into a single string with the
  // heading so a notification with no body still renders cleanly.
  const html = renderEmailShell({
    heading: subject,
    bodyHtml: body ? `<p>${escapeHtml(body)}</p>` : "<p>Open Halomanage to see the details.</p>",
    cta: { text: "Open Halomanage", url: Deno.env.get("NEXT_PUBLIC_SITE_URL") || "https://halomanage-production.up.railway.app/dashboard" },
    footer: "You're receiving this because email notifications are enabled for this notification type. Manage your preferences from your Halomanage profile.",
  });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text: body, html }),
  });
  if (!res.ok) {
    console.error("Resend send failed", res.status, await res.text().catch(() => ""));
  }
  return { ok: res.ok, status: res.status };
}

Deno.serve(async (req) => {
  // Cron-invoked functions call with the service_role key already
  // configured on the schedule — no need to forward a per-user JWT here.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: pending, error } = await admin
    .from("notifications")
    .select("id, recipient_user_id, title, body, type, organization_id")
    .eq("is_read", false)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) return jsonResponse({ error: error.message }, 500);

  let sent = 0;
  for (const n of pending ?? []) {
    const { data: prefs } = await admin
      .from("notification_preferences")
      .select("channel")
      .eq("user_id", n.recipient_user_id)
      .eq("organization_id", n.organization_id)
      .eq("notification_type", n.type)
      .eq("channel", "email")
      .eq("enabled", true)
      .maybeSingle();

    const { data: already } = await admin
      .from("notification_delivery_attempts")
      .select("id")
      .eq("notification_id", n.id)
      .maybeSingle();

    if (!prefs || already) continue;

    const { data: user } = await admin.auth.admin.getUserById(n.recipient_user_id);
    const email = user?.user?.email;
    if (!email) continue;

    const result = await sendEmail(email, n.title, n.body ?? "");
    await admin.from("notification_delivery_attempts").insert({
      notification_id: n.id,
      channel: "email",
      status: result.ok ? "sent" : "failed",
      provider: "email",
      provider_response: result,
    });
    if (result.ok) sent += 1;
  }

  return jsonResponse({ ok: true, checked: pending?.length ?? 0, sent });
});
