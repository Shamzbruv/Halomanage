/** Imported decimal strings stay exact, including large year totals. */
export function formatPayMoney(
  value: string | number | null | undefined,
  currency: string,
) {
  if (
    value === null ||
    value === undefined ||
    !/^-?\d+(\.\d{1,2})?$/.test(String(value))
  )
    return "Not supplied";
  const [whole, fraction = ""] = String(value).split(".");
  return `${currency || "Currency not recorded"} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}
export function sumPayAmounts(
  ...values: (string | number | null | undefined)[]
): string | null {
  if (
    values.some(
      (v) =>
        v === null || v === undefined || !/^-?\d+(\.\d{1,2})?$/.test(String(v)),
    )
  )
    return null;
  const cents = values.reduce<bigint>((sum, v) => {
    const s = String(v);
    const [a, b = ""] = s.replace("-", "").split(".");
    return (
      sum +
      BigInt(a + b.padEnd(2, "0")) *
        (s.startsWith("-") ? BigInt(-1) : BigInt(1))
    );
  }, BigInt(0));
  const abs = cents < BigInt(0) ? -cents : cents;
  return `${cents < BigInt(0) ? "-" : ""}${abs / BigInt(100)}.${String(abs % BigInt(100)).padStart(2, "0")}`;
}
export function formatPayDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Not recorded";
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? "Not recorded"
    : date.toLocaleDateString("en-GB", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}
export type PaySnapshot = {
  id: string;
  batch_id: string;
  employee_id: string;
  employer_name: string;
  employee_name: string;
  employee_number: string;
  position_title: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  pay_date: string | null;
  currency: string;
  gross_pay: string | null;
  regular_pay: string | null;
  overtime_pay: string | null;
  allowances: string | null;
  bonus: string | null;
  tax: string | null;
  other_deductions: string | null;
  net_pay: string | null;
  earnings: unknown;
  deductions: unknown;
  taxes: unknown;
  employer_values: unknown;
};
export type PublishedPay = {
  id: string;
  snapshot: PaySnapshot;
  replaces_id: string | null;
  replaced_by?: string | null;
  legacy_capture: boolean;
  employee_id?: string;
  published_at?: string;
};
export type PayOverview = {
  year: number;
  page: number;
  total: number;
  years: number[];
  currencies: string[];
  totals: {
    currency: string;
    records: number;
    gross: string | null;
    net: string | null;
    tax: string | null;
    other_deductions: string | null;
  }[];
  records: PublishedPay[];
};
export function payItems(
  value: unknown,
): { label: string; amount: string }[] | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (x) =>
        x &&
        typeof x.label === "string" &&
        /^-?\d+(\.\d{1,2})?$/.test(String(x.amount)),
    )
  )
    return null;
  return value.map((x) => ({ label: x.label, amount: String(x.amount) }));
}
