#!/usr/bin/env node
// Pushes supabase/email-templates/templates.mjs onto the live project's
// Auth email config via the Management API (there is no `supabase` CLI
// subcommand for this — auth mailer templates/subjects aren't part of
// `supabase/config.toml`'s scope, unlike Edge Function secrets).
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=... node supabase/scripts/deploy-email-templates.mjs
//
// Never hardcode the token here or pass it as a literal command-line
// argument — always via env var, and never commit one to this repo.

import { emailTemplates } from "../email-templates/templates.mjs";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;

if (!token || !ref) {
  console.error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF first.");
  process.exit(1);
}

const payload = {};
for (const [key, { subject, content }] of Object.entries(emailTemplates)) {
  payload[`mailer_subjects_${key}`] = subject;
  payload[`mailer_templates_${key}_content`] = content;
}

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

console.log("status:", res.status);
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}

console.log(`Deployed ${Object.keys(emailTemplates).length} email templates + subjects.`);
