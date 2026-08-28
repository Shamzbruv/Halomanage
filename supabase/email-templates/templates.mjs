// Halomanage — branded Auth email templates.
//
// Supabase Auth (GoTrue) renders these server-side using its own Go
// template syntax (the `{{ .Field }}` placeholders below) — they are NOT
// evaluated by this file. This module only builds the HTML/subject
// *strings*, which scripts/deploy.mjs then PATCHes verbatim onto the
// project's Auth config via the Management API. Every `{{ .Field }}` used
// here is one GoTrue actually substitutes for that specific email (see
// https://supabase.com/docs/guides/auth/auth-email-templates) — the exact
// same variables Supabase's own defaults used, just restyled, so none of
// this risks breaking substitution.
//
// Source of truth lives here, not in the Supabase dashboard — edit this
// file and redeploy with scripts/deploy-email-templates.mjs rather than
// hand-editing the dashboard's template editor, or the two will drift.
//
// The shell itself lives in functions/_shared/email-shell.mjs, shared with
// send-notifications (a completely separate delivery path — straight to
// Resend, nothing to do with Supabase Auth) so every Halomanage email
// looks like the same product regardless of which system sent it.
import { renderEmailShell as shell } from "../functions/_shared/email-shell.mjs";

const IGNORE_NOTE = "If you didn't expect this email, no action is needed — you can safely ignore it.";
const SECURITY_NOTE = "If this wasn't you, contact your HR administrator immediately.";

// `{{ .ConfirmationURL }}` — what every one of these templates originally
// used, copied from Supabase's own defaults — points at the *hosted*
// `<project-ref>.supabase.co/auth/v1/verify` endpoint. That endpoint
// verifies the token and then hands the session back as a URL *fragment*
// (`#access_token=...`), which only ever reaches client-side JavaScript —
// a server route handler (web/app/auth/callback/route.ts, which every
// email-triggering call in this app was pointed at) can never see it, so
// every single one of these links landed on whatever `next` was requested
// with no session at all. This is a real incident this fixed, not a
// hypothetical: an invite link that "worked" (delivered, branded
// correctly) but silently redirected to a dead localhost URL in
// production, discovered from an actual phone screenshot.
//
// The fix Supabase's own docs recommend for exactly this SSR situation:
// build the confirmation link directly against this app's own
// /auth/confirm route (web/app/auth/confirm/route.ts) using
// `{{ .TokenHash }}` and `{{ .Type }}` instead of `{{ .ConfirmationURL }}`
// — that route calls verifyOtp() itself, server-side, so it never depends
// on a fragment surviving a hop through Supabase's hosted endpoint at all.
// `{{ .SiteURL }}` is the project's configured Site URL (currently
// https://www.myhalomanage.com — see docs/ROADMAP.md); `{{ .RedirectTo }}`
// is whatever emailRedirectTo/redirectTo the *calling* code passed
// (LoginForm, InviteButton, CreateOrganizationForm all pass a full URL on
// this same origin), carried through as the final `next` destination.
function confirmLink(type) {
  return `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}&next={{ .RedirectTo }}`;
}

export const emailTemplates = {
  confirmation: {
    subject: "Confirm your email for Halomanage",
    content: shell({
      heading: "Confirm your email address",
      bodyHtml: "<p>Follow the button below to confirm this email address and finish setting up your Halomanage account.</p>",
      cta: { text: "Confirm email address", url: confirmLink("signup") },
      footer: IGNORE_NOTE,
    }),
  },

  email_change: {
    subject: "Confirm your new email address",
    content: shell({
      heading: "Confirm your new email address",
      bodyHtml: "<p>Follow the button below to confirm <strong>{{ .NewEmail }}</strong> as the new email address for your Halomanage account.</p>",
      cta: { text: "Confirm new email address", url: confirmLink("email_change") },
      footer: IGNORE_NOTE,
    }),
  },

  invite: {
    subject: "You've been invited to Halomanage",
    content: shell({
      heading: "You've been invited",
      bodyHtml: "<p>You've been invited to create a Halomanage account to manage your employee record, time, leave, and more. Follow the button below to accept and set your password.</p>",
      cta: { text: "Accept invitation", url: confirmLink("invite") },
      footer: "This invitation was sent by your organization's HR administrator. If you weren't expecting it, you can safely ignore this email.",
    }),
  },

  magic_link: {
    subject: "Your Halomanage sign-in link",
    content: shell({
      heading: "Your sign-in link",
      bodyHtml: "<p>Follow the button below to sign in to Halomanage. This link expires shortly and can only be used once.</p>",
      cta: { text: "Sign in", url: confirmLink("magiclink") },
      footer: IGNORE_NOTE,
    }),
  },

  reauthentication: {
    subject: "{{ .Token }} is your Halomanage verification code",
    content: shell({
      heading: "Verify it's you",
      bodyHtml: "<p>Use the code below to confirm this sensitive action. It expires shortly and can only be used once.</p>",
      code: "{{ .Token }}",
      footer: SECURITY_NOTE,
    }),
  },

  recovery: {
    subject: "Reset your Halomanage password",
    content: shell({
      heading: "Reset your password",
      bodyHtml: "<p>We received a request to reset the password for your Halomanage account. Follow the button below to choose a new one.</p>",
      cta: { text: "Reset password", url: confirmLink("recovery") },
      footer: `${IGNORE_NOTE} Your password will not change unless you complete the steps above.`,
    }),
  },

  password_changed_notification: {
    subject: "Your Halomanage password was changed",
    content: shell({
      heading: "Your password was changed",
      bodyHtml: "<p>The password for your Halomanage account (<strong>{{ .Email }}</strong>) was just changed.</p>",
      footer: `${SECURITY_NOTE} If you made this change, no further action is needed.`,
    }),
  },

  email_changed_notification: {
    subject: "Your Halomanage email address was changed",
    content: shell({
      heading: "Your email address was changed",
      bodyHtml: "<p>The email address for your Halomanage account was changed from <strong>{{ .OldEmail }}</strong> to <strong>{{ .Email }}</strong>.</p>",
      footer: SECURITY_NOTE,
    }),
  },

  phone_changed_notification: {
    subject: "Your Halomanage phone number was changed",
    content: shell({
      heading: "Your phone number was changed",
      bodyHtml: "<p>The phone number for your Halomanage account was changed from <strong>{{ .OldPhone }}</strong> to <strong>{{ .Phone }}</strong>.</p>",
      footer: SECURITY_NOTE,
    }),
  },

  mfa_factor_enrolled_notification: {
    subject: "A new sign-in method was added to your Halomanage account",
    content: shell({
      heading: "A new verification method was added",
      bodyHtml: "<p>A new <strong>{{ .FactorType }}</strong> sign-in verification method was added to your Halomanage account.</p>",
      footer: SECURITY_NOTE,
    }),
  },

  mfa_factor_unenrolled_notification: {
    subject: "A sign-in method was removed from your Halomanage account",
    content: shell({
      heading: "A verification method was removed",
      bodyHtml: "<p>A <strong>{{ .FactorType }}</strong> sign-in verification method was removed from your Halomanage account.</p>",
      footer: SECURITY_NOTE,
    }),
  },

  identity_linked_notification: {
    subject: "A new sign-in method was linked to your Halomanage account",
    content: shell({
      heading: "A new sign-in method was linked",
      bodyHtml: "<p>Your <strong>{{ .Provider }}</strong> account was linked as a new sign-in method for <strong>{{ .Email }}</strong>.</p>",
      footer: SECURITY_NOTE,
    }),
  },

  identity_unlinked_notification: {
    subject: "A sign-in method was removed from your Halomanage account",
    content: shell({
      heading: "A sign-in method was removed",
      bodyHtml: "<p>Your <strong>{{ .Provider }}</strong> account was removed as a sign-in method for <strong>{{ .Email }}</strong>.</p>",
      footer: SECURITY_NOTE,
    }),
  },
};
