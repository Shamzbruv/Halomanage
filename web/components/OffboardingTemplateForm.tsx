"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function OffboardingTemplateForm({
  organizationId,
  hasTemplates,
}: {
  organizationId: string;
  hasTemplates: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(!hasTemplates);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    if (isDefault) {
      const { error: clearDefaultError } = await supabase
        .from("offboarding_templates")
        .update({ is_default: false })
        .eq("organization_id", organizationId)
        .eq("is_default", true);

      if (clearDefaultError) {
        setError(clearDefaultError.message);
        setLoading(false);
        return;
      }
    }

    const { data: template, error: templateError } = await supabase
      .from("offboarding_templates")
      .insert({
        organization_id: organizationId,
        name: name.trim(),
        is_default: isDefault,
        is_active: true,
      })
      .select("id")
      .single();

    if (templateError || !template) {
      setError(templateError?.message ?? "Could not create the offboarding template.");
      setLoading(false);
      return;
    }

    setName("");
    setLoading(false);
    router.push(`/admin/offboarding/templates/${template.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="label" htmlFor="offboarding-template-name">Template name</label>
        <input
          id="offboarding-template-name"
          required
          placeholder="Standard employee exit"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <label className="flex items-start gap-2 text-sm text-stone-600">
        <input
          className="mt-0.5"
          type="checkbox"
          checked={isDefault}
          onChange={(event) => setIsDefault(event.target.checked)}
        />
        <span>
          Make this the default
          <small className="mt-0.5 block text-xs text-stone-400">Used automatically when an employee is marked as terminated.</small>
        </span>
      </label>
      {error && <p className="alert-error" role="alert">{error}</p>}
      <button type="submit" disabled={loading || !name.trim()} className="btn-primary">
        {loading ? "Creating…" : "Create and add steps"}
      </button>
    </form>
  );
}
