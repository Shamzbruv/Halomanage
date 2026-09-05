import { createClient } from "@/lib/supabase/server";
import { SsoApprovalForm, type SsoRequestRow } from "@/components/platform/SsoApprovalForm";
import { HelpTip } from "@/components/HelpTip";

export default async function PlatformSsoPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_list_sso_requests");
  const requests = (data ?? []) as SsoRequestRow[];

  return (
    <div>
      <div className="platform-topbar">
        <div>
          <span>Enterprise identity</span>
          <h1>SSO connection requests<HelpTip title="SSO connection requests">
            Requests from organizations wanting single sign-on for their email domain. Approving one here moves it from
            &quot;requested&quot; to &quot;configuring&quot; — the organization&apos;s own admin still finishes the actual
            identity-provider setup on their side.
          </HelpTip></h1>
        </div>
      </div>

      {error && <p className="platform-alert-error">{error.message}</p>}

      {requests.length === 0 ? (
        <div className="platform-card"><p className="platform-empty">No organization has requested SSO yet.</p></div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {requests.map((request) => (
            <SsoApprovalForm key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}
