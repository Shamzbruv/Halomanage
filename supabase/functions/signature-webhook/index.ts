// Halomanage — signature-webhook Edge Function
// Ref: ARCHITECTURE.md "Documents and e-signatures" — legally significant
// signatures should go through a real external e-signature provider rather
// than Halomanage reinventing a signature trust platform. This endpoint is
// where that provider calls back when a document is signed/declined.
//
// This is a skeleton: verify the provider's webhook signature (every
// provider has a different scheme — HMAC header, JWT, etc.) before trusting
// the payload, since this endpoint necessarily runs with the service_role
// key to update signature_requests across organizations.
//
// Expected inbound shape here is illustrative — replace with the actual
// provider's payload once one is chosen.

import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { jsonResponse } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const providerSecret = Deno.env.get("SIGNATURE_PROVIDER_WEBHOOK_SECRET");
  const signatureHeader = req.headers.get("x-signature-provider-signature");

  if (providerSecret && signatureHeader !== providerSecret) {
    // Placeholder equality check — replace with the provider's real HMAC
    // verification scheme before production use.
    return jsonResponse({ error: "Invalid webhook signature" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  try {
    const payload = await req.json();
    const externalReference: string | undefined = payload.reference ?? payload.envelope_id;
    const status: string | undefined = payload.status; // expected: "signed" | "declined"

    if (!externalReference || !status) {
      return jsonResponse({ error: "Missing reference/status in webhook payload" }, 400);
    }

    const mappedStatus = status === "signed" ? "signed" : status === "declined" ? "declined" : null;
    if (!mappedStatus) {
      return jsonResponse({ error: `Unrecognized status '${status}'` }, 400);
    }

    const { data: request, error } = await admin
      .from("signature_requests")
      .update({ status: mappedStatus, completed_at: new Date().toISOString() })
      .eq("external_reference", externalReference)
      .select()
      .single();

    if (error || !request) {
      return jsonResponse({ error: "No matching signature request found" }, 404);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
