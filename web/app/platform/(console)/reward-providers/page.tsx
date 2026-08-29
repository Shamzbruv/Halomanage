import { createClient } from "@/lib/supabase/server";
import { NewRewardProviderForm } from "@/components/platform/NewRewardProviderForm";
import { ToggleProviderActiveButton } from "@/components/platform/ToggleProviderActiveButton";

export default async function PlatformRewardProvidersPage() {
  const supabase = await createClient();
  const { data: providers } = await supabase.from("reward_providers").select("*").order("key");

  return (
    <div>
      <div className="platform-topbar">
        <div>
          <span>Rewards infrastructure</span>
          <h1>Reward providers</h1>
        </div>
        <NewRewardProviderForm />
      </div>

      <div className="platform-card">
        <p style={{ marginBottom: "1rem", color: "var(--p-text-muted)", fontSize: "0.82rem" }}>
          &ldquo;Manual&rdquo; is always available to every organization at no cost — HR fulfills the reward directly.
          An automatic_api provider only becomes usable once it&apos;s active here <em>and</em> a real integration
          with API credentials exists in Edge Function secrets (never stored in this table).
        </p>
        {(providers ?? []).length === 0 ? (
          <p className="platform-empty">No providers yet.</p>
        ) : (
          <table className="platform-table">
            <thead><tr><th>Key</th><th>Name</th><th>Fulfillment</th><th>Status</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {(providers ?? []).map((provider) => (
                <tr key={provider.id}>
                  <td style={{ fontFamily: "monospace", fontSize: "0.76rem" }}>{provider.key}</td>
                  <td>{provider.name}</td>
                  <td><span className="platform-badge accent">{provider.fulfillment_type}</span></td>
                  <td><span className={`platform-badge ${provider.is_active ? "success" : "neutral"}`}>{provider.is_active ? "Active" : "Inactive"}</span></td>
                  <td style={{ color: "var(--p-text-muted)", fontSize: "0.78rem" }}>{provider.notes ?? "—"}</td>
                  <td>{provider.key !== "manual" && <ToggleProviderActiveButton providerId={provider.id} isActive={provider.is_active} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
