// Halomanage — shared branded email shell.
//
// Plain .mjs (no TypeScript syntax) so this one file is importable
// unmodified from two different runtimes that otherwise share nothing:
// Deno (supabase/functions/send-notifications/index.ts, which sends its
// own emails straight through Resend) and Node
// (supabase/email-templates/templates.mjs + scripts/deploy-email-templates.mjs,
// which push Supabase Auth's mailer templates via the Management API).
// Living under functions/_shared/ specifically (rather than
// email-templates/) is what guarantees `supabase functions deploy` traces
// and bundles it — that command uploads a function's own relative import
// graph, not arbitrary sibling directories elsewhere in the repo.
//
// Table-based layout with inline styles throughout is deliberate, not an
// oversight: flexbox/CSS-grid and <style> blocks are unreliable across
// email clients (Outlook desktop in particular) — a plain nested <table>
// with inline styles is still the layout that reliably renders the same
// everywhere.

export const NAVY = "#101B3D";
export const TEAL = "#129C86";
export const INK = "#3f4757";
export const MUTED = "#8993a3";
const BG = "#f0f2f6";
const CARD_BG = "#ffffff";
const CODE_BG = "#f3f5f8";

export function renderEmailShell({ heading, bodyHtml, cta, code, footer }) {
  const ctaBlock = cta
    ? `
        <tr>
          <td style="padding:4px 32px 28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="border-radius:8px;background-color:${TEAL};">
                <a href="${cta.url}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${cta.text}</a>
              </td>
            </tr></table>
            <p style="margin:16px 0 0 0;font-size:12px;line-height:1.5;color:${MUTED};word-break:break-all;">Or copy and paste this link into your browser:<br /><a href="${cta.url}" style="color:${TEAL};">${cta.url}</a></p>
          </td>
        </tr>`
    : "";

  const codeBlock = code
    ? `
        <tr>
          <td style="padding:4px 32px 28px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="center" style="background-color:${CODE_BG};border-radius:8px;padding:18px;">
                <span style="font-size:30px;font-weight:700;letter-spacing:8px;color:${NAVY};font-family:'SF Mono',Consolas,Menlo,monospace;">${code}</span>
              </td>
            </tr></table>
          </td>
        </tr>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:36px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:${CARD_BG};border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background-color:${NAVY};padding:26px 32px;">
                <span style="font-size:19px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Halo<span style="color:${TEAL};">manage</span></span>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 6px 32px;">
                <h1 style="margin:0 0 14px 0;font-size:21px;line-height:1.35;color:${NAVY};font-weight:700;">${heading}</h1>
                <div style="font-size:15px;line-height:1.65;color:${INK};">${bodyHtml}</div>
              </td>
            </tr>
            ${codeBlock}
            ${ctaBlock}
            <tr>
              <td style="padding:22px 32px 30px 32px;border-top:1px solid #eef0f4;">
                <p style="margin:0;font-size:12.5px;line-height:1.6;color:${MUTED};">${footer}</p>
              </td>
            </tr>
          </table>
          <p style="max-width:600px;margin:18px auto 0 auto;font-size:11.5px;color:#aab1bd;">© ${new Date().getFullYear()} Halomanage — HR &amp; employee management, without the payroll engine.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
