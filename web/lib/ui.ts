// Shared UI helpers for the skeuomorphic gold/royal-blue/parchment theme.
// Status colors stay semantically conventional (good=green, bad=red) but
// are rendered as the same "gem" badge family as everything else — see
// .badge-* in app/globals.css. Centralized here instead of copy-pasted
// per page so the mapping only needs to be right once.
const GOOD = new Set(["approved", "active", "completed", "matched", "on_time", "fulfilled"]);
const BAD = new Set([
  "rejected", "cancelled", "needs_review", "terminated", "withdrawn", "unmatched", "invalid", "late", "failed",
]);
const NEUTRAL = new Set(["superseded", "prehire", "skipped"]);
// Everything else — submitted, pending_supervisor, pending_manager,
// ready_for_approval, leave, suspended, uploaded, processing, in_progress —
// reads as "in progress / needs attention", which is what gold signals
// throughout this theme.

export function statusBadgeClass(status: string): string {
  if (GOOD.has(status)) return "badge-emerald";
  if (BAD.has(status)) return "badge-ruby";
  if (NEUTRAL.has(status)) return "badge-neutral";
  return "badge-gold";
}

// Admin reads as gold (authority); every other role reads as the royal
// "neutral" gem — both pop cleanly against the header's dark royal-blue.
export function roleBadgeClass(role: string | null): string {
  return role === "admin" ? "badge-gold" : "badge-neutral";
}
