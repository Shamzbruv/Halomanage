// Phone numbers are stored in E.164 (+18765551234) — the database
// normalizes every write (private.normalize_phone in
// 20261003100000_my_profile_employee_record.sql). This only formats them
// for people to read; anything not in a recognised shape is shown as stored.

export function formatPhone(value: string | null | undefined): string {
  if (!value) return "";
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  if (nanp) return `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}`;
  const international = /^\+(\d{1,3})(\d+)$/.exec(value);
  if (international) return `+${international[1]} ${international[2].replace(/(\d{3,4})(?=\d)/g, "$1 ")}`;
  return value;
}
