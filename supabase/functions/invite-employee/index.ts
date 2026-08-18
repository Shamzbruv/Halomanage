// Halomanage — invite-employee Edge Function
// Ref: ARCHITECTURE.md "Authentication strategy".
//
// Employer-controlled invitations, never public signup. An Admin/HR user
// (someone who can already SELECT the target employees row — enforced by
// RLS via the "caller" client below, which uses their JWT, not a bypass)
// triggers this function. It then performs the *privileged* Supabase Auth
// admin operation — which requires the service_role key and must never run
// in browser/mobile code — and links the new auth.users row back to the
// employees record.
//
// Request body: { "employee_id": "<uuid>", "redirect_to"?: "<url>" }

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");

  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  try {
    const { employee_id, redirect_to } = await req.json();
    if (!employee_id) {
      return jsonResponse({ error: "employee_id is required" }, 400);
    }

    // Caller-scoped client: runs under the *caller's* JWT, so RLS applies
    // exactly as it would from the browser. If this SELECT returns nothing,
    // the caller either can't see this employee or lacks employee.manage —
    // either way, not authorized to invite them. This is the entire
    // authorization check; nothing here bypasses RLS.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: employee, error: employeeError } = await callerClient
      .from("employees")
      .select("id, organization_id, user_id, work_email, first_name, last_name, status")
      .eq("id", employee_id)
      .single();

    if (employeeError || !employee) {
      return jsonResponse({ error: "Not authorized to invite this employee" }, 403);
    }
    if (employee.user_id) {
      return jsonResponse({ error: "Employee already has an account" }, 409);
    }
    if (!employee.work_email) {
      return jsonResponse({ error: "Employee has no work_email on file" }, 400);
    }

    // Privileged client: service_role bypasses RLS and can call Auth admin
    // APIs. Never expose this key to a browser/mobile client.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: invite, error: inviteError } = await adminClient.auth.admin
      .inviteUserByEmail(employee.work_email, {
        redirectTo: redirect_to,
        data: {
          employee_id: employee.id,
          organization_id: employee.organization_id,
        },
      });

    if (inviteError || !invite?.user) {
      return jsonResponse({ error: inviteError?.message ?? "Failed to send invitation" }, 500);
    }

    const { error: linkError } = await adminClient
      .from("employees")
      .update({ user_id: invite.user.id })
      .eq("id", employee.id);

    if (linkError) {
      return jsonResponse({ error: `Invited but failed to link account: ${linkError.message}` }, 500);
    }

    // Give the new user their baseline "employee" role in this org — every
    // employee should hold at least this so private.is_org_member() and the
    // default role_permissions bundle apply immediately.
    await adminClient.from("role_assignments").insert({
      organization_id: employee.organization_id,
      user_id: invite.user.id,
      role: "employee",
    });

    // service_role bypasses RLS (and has default schema privileges) so this
    // is a plain table insert, not a call through private.log_audit_event()
    // — that helper is SECURITY DEFINER specifically so `authenticated`
    // clients can log without an INSERT policy; server code doesn't need it.
    // Best-effort: a logging failure shouldn't fail an otherwise-successful
    // invite.
    try {
      await adminClient.from("audit_events").insert({
        organization_id: employee.organization_id,
        actor_user_id: null,
        employee_id: employee.id,
        action: "EMPLOYEE_INVITED",
        entity_type: "employee",
        entity_id: employee.id,
        new_data: { user_id: invite.user.id, work_email: employee.work_email },
      });
    } catch {
      // swallow — see comment above
    }

    return jsonResponse({ ok: true, user_id: invite.user.id });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
