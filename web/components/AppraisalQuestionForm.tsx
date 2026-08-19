"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AppraisalQuestionForm({ sectionId, nextSequence }: { sectionId: string; nextSequence: number }) {
  const supabase = createClient();
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState("rating_scale");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("appraisal_questions").insert({
      section_id: sectionId,
      prompt,
      question_type: type,
      sequence: nextSequence,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setPrompt("");
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2 pl-4">
      <div className="flex-1">
        <input required placeholder="Question prompt" className="input" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      <select className="input w-40" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="rating_scale">Rating scale</option>
        <option value="numeric_rating">Numeric rating</option>
        <option value="text">Free text</option>
        <option value="yes_no">Yes / No</option>
        <option value="goal">Goal</option>
      </select>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !prompt} className="btn-secondary px-3 py-1.5 text-xs">{loading ? "…" : "Add"}</button>
    </form>
  );
}
