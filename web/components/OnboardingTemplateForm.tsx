"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Creates the template *and* its first version (version_number 1,
// is_current) in one go — a template with no current version can't be
// started (start_onboarding() requires one), so there's no useful
// intermediate state to leave half-created.
export function OnboardingTemplateForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { data: template, error: templateError } = await supabase
      .from("onboarding_templates")
      .insert({ organization_id: organizationId, name, is_default: isDefault })
      .select()
      .single();

    if (templateError || !template) {
      setError(templateError?.message ?? "Failed to create template");
      setLoading(false);
      return;
    }

    const { error: versionError } = await supabase
      .from("onboarding_template_versions")
      .insert({ template_id: template.id, version_number: 1, is_current: true });

    if (versionError) {
      setError(versionError.message);
      setLoading(false);
      return;
    }

    setName("");
    setIsDefault(false);
    setLoading(false);
    router.push(`/admin/onboarding/templates/${template.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex-1">
        <label className="label">New template name</label>
        <input required placeholder="New Employee Onboarding" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <label className="mb-2 flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Default template
      </label>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !name} className="btn-primary">
        {loading ? "Creating…" : "Create & edit steps"}
      </button>
    </form>
  );
}
