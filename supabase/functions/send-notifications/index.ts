// Halomanage — send-notifications Edge Function
// Ref: ARCHITECTURE.md "Notifications" — in-app notifications are fully
// Supabase-native (a row + Realtime); email/SMS/push need an outbound
// provider, which is exactly what does NOT belong in a client-callable RPC
// (it needs a provider API key, which must stay server-side).
//
// Intended to run on a short Cron schedule (e.g. every 1–2 minutes) via
// Supabase Cron invoking this function, not to be called by the client
// directly. It looks for notifications that have an enabled non-in_app
// channel preference and no delivery attempt yet, and — once a provider is
// wired up below — sends and records the attempt.
//
// This is deliberately left as a real, runnable skeleton rather than a
// fully wired provider integration: plug in Resend/SendGrid/Twilio/FCM
// under sendEmail/sendSms/sendPush and set the corresponding secret via
// `supabase secrets set`. See docs/ROADMAP.md.

import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/cors.ts";

async function sendEmail(to: string, subject: string, body: string) {
  const apiKey = Deno.env.get("EMAIL_PROVIDER_API_KEY");
  if (!apiKey) {
    console.warn("EMAIL_PROVIDER_API_KEY not set — skipping email send (dev mode)");
    return { ok: true, skipped: true };
  }
  // Example shape for a provider like Resend; adjust to whichever provider
  // is actually configured.
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("EMAIL_FROM_ADDRESS"), to, subject, text: body }),
  });
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
