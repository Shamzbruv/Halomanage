// Shared between RequestDocumentForm (client), the employee's "My requests"
// list, the admin fulfillment queue, and the dashboard's admin-actions feed
// (server components) — kept in a plain module rather than inside a "use
// client" component file so every one of those can import it cleanly.
export const REQUEST_TYPES = [
  { value: "employment_verification", label: "Employment verification letter" },
  { value: "salary_verification", label: "Salary verification letter" },
  { value: "reference_letter", label: "Reference letter" },
  { value: "certificate_of_service", label: "Certificate of service" },
  { value: "other", label: "Other" },
] as const;

export function requestTypeLabel(type: string, otherLabel: string | null | undefined): string {
  if (type === "other") return otherLabel || "Other";
  return REQUEST_TYPES.find((candidate) => candidate.value === type)?.label ?? type;
}
