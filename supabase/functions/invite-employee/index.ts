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
// Request body: { "employee_id": "<uuid>", "redirect_to"?: "<url>", "resend"?: boolean }
//   or, to fix an invite sent to the wrong address:
//               { "employee_id": "<uuid>", "correct_email": "<new address>" }
//
// `resend` exists because inviteUserByEmail() can only ever be called once
// per email — Supabase Auth rejects a second call for an address that
// already has a user, confirmed or not. Without this, an invite email
// that goes out with a broken link (the real incident this was built to
// fix: Site URL was still the dev default of localhost:3000 on the live
// project, so every invite link was dead until that got corrected) had no
// recovery path at all short of deleting and recreating the employee
// record. Resend instead generates a fresh action link for the *existing*
// auth user via generateLink({ type: "recovery" }) — which works
// regardless of prior confirmation state, unlike re-inviting — and emails
// it directly through Resend using the same branded template as every
// other outbound Halomanage email, rather than depending on GoTrue's own
// (invite-only) send path a second time.
//
// `correct_email` handles the narrower, different problem of the address
// itself being wrong. A plain employees.work_email update alone would
// orphan the situation: the pending auth account is still keyed to the
// old address, so Resend's generateLink(email: <new address>) would find
// no matching user. Only reachable while the linked account has never
// signed in — once accepted, changing work_email is a plain HR-record
// edit the client already does directly via the Data API (RLS already
// permits it for employee.manage), with no auth.users involvement at all.

import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { renderEmailShell } from "../_shared/email-shell.mjs";

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
    const { employee_id, redirect_to, resend, correct_email } = await req.json();
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

    // Privileged client: service_role bypasses RLS and can call Auth admin
    // APIs. Never expose this key to a browser/mobile client.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (correct_email) {
      if (!employee.user_id) {
        return jsonResponse({ error: "This employee hasn't been invited yet — just edit their email and invite them." }, 400);
      }
      const { data: userLookup, error: userLookupError } = await adminClient.auth.admin.getUserById(employee.user_id);
      if (userLookupError || !userLookup?.user) {
        return jsonResponse({ error: "Could not find this employee's account." }, 500);
      }
      if (userLookup.user.last_sign_in_at) {
        return jsonResponse({ error: "This employee has already accepted their invitation and signed in — this can only fix a still-pending invite." }, 409);
      }

      const { error: deleteError } = await adminClient.auth.admin.deleteUser(employee.user_id);
      if (deleteError) {
        return jsonResponse({ error: `Could not remove the pending invitation: ${deleteError.message}` }, 500);
      }
      const { error: updateError } = await adminClient
        .from("employees")
        .update({ work_email: correct_email, user_id: null })
        .eq("id", employee_id);
      if (updateError) {
        return jsonResponse({ error: `The old invitation was removed, but the email could not be saved: ${updateError.message}` }, 500);
      }

      const { error: auditError } = await callerClient.rpc("record_employee_email_correction", {
        p_employee_id: employee_id,
        p_old_email: employee.work_email,
        p_new_email: correct_email,
      });
      if (auditError) {
        console.error("record_employee_email_correction failed (non-fatal):", auditError.message);
      }

      return jsonResponse({ ok: true, corrected: true });
    }

    if (!employee.work_email) {
      return jsonResponse({ error: "Employee has no work_email on file" }, 400);
    }

    if (resend) {
      if (!employee.user_id) {
        return jsonResponse({ error: "This employee hasn't been invited yet — use Invite instead." }, 400);
      }

      const { data: userLookup, error: userLookupError } = await adminClient.auth.admin.getUserById(employee.user_id);
      if (userLookupError || !userLookup?.user) {
        return jsonResponse({ error: "Could not find this employee's account to resend an invitation to." }, 500);
      }
      if (userLookup.user.last_sign_in_at) {
        return jsonResponse({ error: "This employee has already signed in at least once — there's nothing to resend." }, 409);
      }

      const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
        type: "recovery",
        email: employee.work_email,
        options: { redirectTo: redirect_to },
      });
      if (linkError || !linkData) {
        return jsonResponse({ error: linkError?.message ?? "Could not generate a new invitation link" }, 500);
      }

      const apiKey = Deno.env.get("RESEND_API_KEY");
      if (!apiKey) {
        return jsonResponse({ error: "Email sending isn't configured for this deployment (RESEND_API_KEY missing)." }, 500);
      }
      const from = Deno.env.get("EMAIL_FROM_ADDRESS") || "Halomanage <notifications@myhalomanage.com>";
      // linkData.properties.action_link points at Supabase's *hosted*
      // verify endpoint, which hands sessions back as a URL fragment on
      // success — invisible to a server route handler, which is exactly
      // the bug this whole fix addresses (see the long comment in
      // supabase/email-templates/templates.mjs). Build a link straight to
      // this app's own /auth/confirm route instead, using the raw
      // hashed_token generateLink() also returns, so it verifies
      // server-side via verifyOtp() and never depends on a fragment.
      const confirmUrl = new URL("/auth/confirm", new URL(redirect_to).origin);
      confirmUrl.searchParams.set("token_hash", linkData.properties.hashed_token);
      confirmUrl.searchParams.set("type", "recovery");
      confirmUrl.searchParams.set("next", redirect_to);
      const actionLink = confirmUrl.toString();
      const html = renderEmailShell({
        heading: "You've been invited",
        bodyHtml: "<p>You've been invited to create a Halomanage account to manage your employee record, time, leave, and more. Follow the button below to accept and set your password.</p>",
        cta: { text: "Accept invitation", url: actionLink },
        footer: "This invitation was sent by your organization's HR administrator. If you weren't expecting it, you can safely ignore this email.",
      });

      const sendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [employee.work_email],
          subject: "You've been invited to Halomanage",
          text: `You've been invited to create a Halomanage account. Accept your invitation: ${actionLink}`,
          html,
        }),
      });
      if (!sendRes.ok) {
        const detail = await sendRes.text().catch(() => "");
        return jsonResponse({ error: `Could not send the invitation email (${sendRes.status}). ${detail}`.trim() }, 502);
      }

      return jsonResponse({ ok: true, resent: true });
    }

    if (employee.user_id) {
      return jsonResponse({ error: "Employee already has an account" }, 409);
    }

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
