// Halomanage — invite-employee Edge Function
// Ref: ARCHITECTURE.md "Authentication strategy".
//
// Employer-controlled invitations, never public signup. An Admin/HR user
// must hold employee.manage for the target organization; merely being able
// to read a direct report is intentionally not enough.
// triggers this function. It then performs the *privileged* Supabase Auth
// admin operation — which requires the service_role key and must never run
// in browser/mobile code — and links the new auth.users row back to the
// employees record.
//
// Request body: { "employee_id": "<uuid>", "redirect_to"?: "<url>" }

import { createClient } from "npm:@supabase/supabase-js@2.112.4";
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

    // Caller-scoped client: explicit permission RPC plus RLS-scoped read.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: canInvite, error: permissionError } = await callerClient
      .rpc("can_invite_employee", { p_employee_id: employee_id });
    if (permissionError || !canInvite) {
      return jsonResponse({ error: "Not authorized to invite this employee" }, 403);
    }

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

    const { data: organization } = await adminClient
      .from("organizations")
      .select("slug")
      .eq("id", employee.organization_id)
      .single();

    const { data: invite, error: inviteError } = await adminClient.auth.admin
      .inviteUserByEmail(employee.work_email, {
        redirectTo: redirect_to,
        data: {
          employee_id: employee.id,
          organization_id: employee.organization_id,
          organization_slug: organization?.slug,
        },
      });

    if (inviteError || !invite?.user) {
      return jsonResponse({ error: inviteError?.message ?? "Failed to send invitation" }, 500);
    }

    const { error: linkError } = await adminClient.rpc("link_invited_employee_account", {
      p_employee_id: employee.id,
      p_user_id: invite.user.id,
    });

    if (linkError) {
      await adminClient.auth.admin.deleteUser(invite.user.id);
      return jsonResponse({ error: `Invitation could not be connected to the employee record: ${linkError.message}` }, 500);
    }

    return jsonResponse({ ok: true, user_id: invite.user.id });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
