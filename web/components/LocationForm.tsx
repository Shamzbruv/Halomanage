"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LocationForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("locations").insert({
      organization_id: organizationId,
      name,
      city: city || null,
      country_code: countryCode || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setName("");
    setCity("");
    setCountryCode("");
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input required placeholder="Name (e.g. Kingston HQ)" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="City" className="input" value={city} onChange={(e) => setCity(e.target.value)} />
        <input placeholder="Country code (JM)" className="input" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading} className="btn-secondary w-full">
        {loading ? "Adding…" : "Add location"}
      </button>
    </form>
  );
}
