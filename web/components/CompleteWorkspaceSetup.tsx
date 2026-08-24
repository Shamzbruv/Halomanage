"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export function CompleteWorkspaceSetup() {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    async function finish() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      const metadata = user?.user_metadata ?? {};

      if (!user || metadata.signup_intent !== "organization_owner") {
        setError("We couldn’t find the organization details from your signup. Please return to create workspace and try again.");
        return;
      }

      const { error: workspaceError } = await supabase.rpc("create_organization_workspace", {
        p_organization_name: metadata.organization_name,
        p_slug: metadata.organization_slug,
        p_first_name: metadata.first_name,
        p_last_name: metadata.last_name,
        p_timezone: metadata.timezone || "UTC",
        p_country_code: metadata.country_code || null,
      });

      if (workspaceError && !workspaceError.message.toLowerCase().includes("already belongs")) {
        setError(workspaceError.message);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    }

    void finish();
  }, [router]);

  return (
    <div className="auth-panel">
      <div className="auth-card">
        <div className="auth-form signup-confirmation">
          {error ? (
            <><span className="signup-confirmation-icon error">!</span><div><h3>We need one more step</h3><p>{error}</p><a className="btn-secondary mt-4" href="/signup">Return to signup</a></div></>
          ) : (
            <><span className="setup-spinner" aria-hidden="true" /><div><h3>Preparing your workspace</h3><p>We&apos;re connecting your administrator account and organization settings. This should only take a moment.</p></div></>
          )}
        </div>
      </div>
    </div>
  );
}
