// Exactly the employee_private columns the personal-information form reads
// or writes — never select("*") (data minimization: a page gets only what
// it shows).
//
// This lives in lib/, not in the "use client" form component: a value
// exported from a "use client" module reaches Server Components as a client
// reference, not as the string, which broke the query on My Profile.
export const PERSONAL_INFO_COLUMNS =
  "personal_email, personal_phone, date_of_birth, gender, marital_status, address_line1, address_line2, city, region, country_code, postal_code";
