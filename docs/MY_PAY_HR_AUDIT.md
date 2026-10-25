# My Pay — HR and engineering audit

Reviewed 25 October 2026. Scope: employee compensation, pay calendars, imported pay results, payslips, HR reconciliation, corrections, access and pay enquiries. The release uses GitHub main for the web application; no Railway operations are involved.

## HR research and decisions

The review uses Jamaican primary sources because the established HaloManage HR work targets Jamaica. These are product decisions informed by the sources, not a declaration that software alone establishes legal compliance.

- [Jamaica Office of the Information Commissioner: data protection standards](https://www.oic.gov.jm/page/data-protection-standards) describes minimization, accuracy, access rights, retention and appropriate security measures. Pay views now expose only published employee records; raw spreadsheet content and HR commentary stay outside employee self-service. Application access controls and organization MFA apply. A retention period still requires the employer's documented policy and applicable legal requirements; this release does not invent a statutory period or automatically purge financial evidence.
- [MLSS: Departments](https://www.mlss.gov.jm/departments/) advises workers disputing salary calculations to contact HR or their supervisor/employer with their pay advice. That guidance appears in the overseas-employment material, so it is used here as a practical enquiry pattern, not a universal Jamaican statutory procedure. HaloManage now links a private employee–HR query thread to a payslip, preserves responses and supports reopening and a linked resolution.
- [MLSS: Pay and Conditions of Employment Branch](https://www.mlss.gov.jm/departments/pay-and-conditions-of-employment-branch/) explains its pay/conditions advisory, investigation and records-inspection role. Stable references, preserved historical statements and audited corrections support review of an employee's concern.
- [MLSS SPIRO Labour Management Procedures, July 2024](https://www.mlss.gov.jm/wp-content/uploads/2024/07/Labour-Management-Procedures-LMP-JAMAICA-SPIRO-FINAL.pdf) discusses agreed pay arrangements and deduction transparency within that project's employment framework. HaloManage distinguishes contractual gross rates from period earnings, deductions and net pay. Schedules follow assigned employer calendars, not a fabricated nationwide payday.
- [ILO: wages and benefits questions and answers](https://www.ilo.org/resource/qas-business-wages-and-benefits-0) provides a reference for understandable pay and deductions information. Supported labelled itemizations are displayed; absent values remain unknown rather than being presented as zero.
- [NHT: employer contributions](https://nht.gov.jm/index.php/employer-contribution) distinguishes the employer's contribution responsibilities. Imported employer contributions have their own payslip section and are not subtracted again from employee net pay. Current tax and contribution rates remain the external payroll provider's responsibility.

Technical source: [SheetJS's official Deno installation](https://docs.sheetjs.com/docs/getting-started/installation/deno/) supplies the pinned 0.20.3 module and types, replacing the older npm build. The official release is vendored with its Apache license, source hash and build provenance because the Supabase bundler cannot import that CDN module directly.

## Gaps fixed

| Previous gap | Result |
|---|---|
| My Pay required compensation permission even to view a payslip | Compensation and payroll sections use their respective self permissions |
| Employee compensation selected confidential free-text HR notes | Notes move to a separate HR-only table; the compatibility column is cleared on every write |
| Payroll RLS allowed self rows without checking self pay permission | Published record RLS checks the effective grant and required MFA; staging and file metadata are importer-only |
| A payslip used today's employer/name/position | Publication captures identity and the position effective at the period end |
| Posted source rows, batch metadata and statements could change | Database triggers reject changes to posted financial evidence |
| Replacing a batch hid omitted employees | Replacement links are per employee record; omitted employees remain current |
| Old payslip URLs stopped working after correction | Historical statements retain their URL and link to the replacement |
| Approval trusted cached status flags; empty/duplicate/inconsistent rows could pass | Approval locks, revalidates source rows, checks tenant, type, totals, itemization and duplicates, then publishes atomically |
| Compensation imports could silently skip an insert | Conflicts in date or old amount fail the whole transaction; approval requires compensation authority and carries existing rate terms forward |
| Email fallback and conflicting identifiers could select the wrong employee | Automatic matching requires stable identifiers to agree; HR rematches require a reason and audit |
| Row-level currency and dates were discarded; malformed values became null | Parser errors persist separately and cannot be cleared by rematching |
| Processing status update ran through an unwritable RLS path | A narrow RPC atomically claims the batch with importer and step-up checks |
| Upload always declared USD | HR explicitly enters currency; corrections retain original metadata |
| Missing deduction/allowance amounts became zero | Missing values are displayed as not supplied; combined totals remain unknown when incomplete |
| Only the newest 24 records could be reached | Year/currency filtering, all-pay-date history and pagination; exact decimal totals by currency |
| Scheduled canceled periods could be shown as the next payment | Employee and HR compensation schedules exclude canceled periods and use organization-local effective dates |
| Payslip route bypassed the portal's MFA gate | Standalone route checks security policy; database record reads independently enforce required MFA |
| No pay-error workflow | Private query, HR response, status, reopening, notification and resolution record links |
| No payslip publication notification | Employees receive an in-app notice containing no pay amounts |

## Import contract and review

Use one CSV/XLSX/XLS worksheet, at most 10 MB and 10,000 data rows. Default CSV headers are downloadable from the upload form. Stable IDs are exact strings: preserve leading zeros in spreadsheets. Names and emails do not auto-match. A pay run needs period start, period end, pay date, a three-letter uppercase currency code, gross pay and net pay. Optional amounts accept up to twelve whole digits and two decimals. ISO dates must be real `YYYY-MM-DD` dates. Excel date cells are supported through the workbook parser. Conflicting identifiers require explicit HR reconciliation.

Optional JSON columns `Earnings`, `Deductions`, `Taxes` and `Employer Contributions` accept arrays such as `[{"label":"Income tax","amount":"100.00","code":"PAYE"}]`. Earnings correspond to gross, taxes to the tax total, and deductions to other deductions. Employer contributions are informational. A supplied breakdown must agree with its supplied total. Legacy nonstandard itemization is not guessed or relabelled.

Database validation compares imported totals; it does not calculate an employee's entitlement, tax, gross earnings or net pay. Complete supplied scalar earnings must add to supplied gross; supplied gross less tax and other deductions must agree with supplied net. A source with partial breakdown values can remain publishable, with missing values explicitly unknown. Negative net adjustments are preserved; negative gross and non-finite amounts cannot be published.

HR reviews the source rows and summary at `/admin/payroll/[id]`, confirms rematches, revalidates and approves or rejects with an explanation. Source amount/date errors require a corrected file. Upload retries reuse the same non-rejected batch for the same file fingerprint and import metadata. This detects exact repeats; HR still reviews legitimate off-cycle runs and differently generated duplicate files.

Pay corrections use the original batch's period, pay date and currency and replace current records for included employees only. Conflicting correction branches are rejected. Multiple correction generations retain a navigable chain. A contractual compensation correction uses the separate effective-dated HR workflow. Approval is audited; this release does not impose a new two-person rule on organizations that have not configured one.

## Integration boundaries

- Current and future compensation use employer-local dates, assigned pay group/calendar and explicit rate units. Contractual rates and component assignments are not assumed to equal a particular net payment.
- Attendance and leave feed the existing approved timesheet/export workflow. Importing pay does not rewrite approved hours, make a second leave-ledger deduction or infer an unpaid-leave amount. HR must review externally calculated payroll against those records.
- Payslips are employer-published records, not bank-transfer confirmation or tax certificates. Year totals include only available current records and remain separate by currency. Unknown amounts produce unknown totals rather than partial totals labelled complete.
- New privileged implementations live in unexposed `pay_internal`; public RPCs are invokers with anonymous execution revoked. New tables have explicit grants and scoped RLS. Query message history and statements are append-only through ordinary workflows. Required MFA is enforced for raw-source reads too.
- Views, queries and downloads use dynamic rendering, private/no-store caching, no-index and no-referrer headers. Browser printing provides Save as PDF. Access to a payslip is audited; this does not claim to prove a browser completed printing or saving a file.
- Existing posted records are captured once as legacy statements, with a visible warning that historical identity may reflect migration-time information. This project's deployment preflight found no existing posted batches or staged rows.
- Used source files remain private and retained. Only unregistered orphan uploads may be removed through the new cleanup policy. Employer retention/legal-hold procedures and backup of storage objects remain operational responsibilities.

## Validation

The regression suite applies every repository migration to Postgres/PGlite and exercises real grants, RLS, RPCs and triggers, plus the shared source parser and decimal/date display helpers. It covers cross-tenant and cross-employee denial, independent/revoked permissions, required MFA, immutable evidence, approval retries, exact-repeat imports, partial and conflicting corrections, separate currency totals, incomplete deductions, source errors surviving rematches, duplicate employees, itemization and the enquiry lifecycle. Web validation includes lint, TypeScript, client-boundary checks and a production build. A live transaction smoke test must be rolled back so no sample pay or queries remain.

Signed-in browser acceptance with an actual employee and payroll reviewer is not included in the automated checks. The source-based tests do not claim that every external payroll vendor layout or every employer policy has been certified. Provider mapping administration, automatic provider delivery and statutory rate calculation remain outside this release.

Release verification: 630 assertions passed; lint has zero errors (ten existing warnings), TypeScript/client-boundary checks and the production build passed. The import function also passed Deno type checking using the installed dependency tree. The live publication/privacy/query smoke transaction passed and rolled back. Security advisor comparisons and GitHub CI are checked as release gates.

The CI pass also exercises a forced UTC/employer-local date boundary: compensation, pay group, calendar and period visibility follow the employer date, and a future rate does not activate its group early. An older compensation fixture was corrected to use the employer date rather than UTC current_date.
