# Leave — HR audit and implemented workflow

Reviewed 24 October 2026 (Jamaica). Scope: employee Leave, team approvals, HR leave rules,
private evidence, balances, recurring credits, attendance and approved-timesheet exports.

## Research and policy decisions

Primary Jamaican sources reviewed:

- [Consolidated Holidays with Pay Order](https://laws.moj.gov.jm/legislation/subsids/H/The%20Holidays%20with%20Pay%20Act.pdf).
- [Employment (Flexible Work Arrangements) Act 2014](https://www.mlss.gov.jm/wp-content/uploads/2018/02/Employment-Flexible-Work-Arrangements-Miscellaneous-Provisions-Act-2014.pdf), including its amendment of the Holidays with Pay Order. The older standalone Order must be read with these amendments; Sunday is not treated as a universally excluded day in this implementation.
- [Maternity Leave Act](https://www.mlss.gov.jm/wp-content/uploads/2017/11/Maternity-Leave-Act.pdf).
- [MLSS industrial-relations guidance](https://www.mlss.gov.jm/departments/industrial-relations/).

The implementation distinguishes a normal working week from an assumed five-day calendar,
and distinguishes permission to be absent from paid entitlement. Maternity eligibility,
pay phases and employer agreements need separate HR configuration; the system does not decide
someone's statutory entitlement from a generic global template. Existing entitlements were
preserved rather than replaced with a claimed universally compliant default.

Professional practice references:

- [CIPD: Absence measurement and management](https://www.cipd.org/uk/knowledge/factsheets/absence-factsheet): clear, consistent policies and employee support. Only public factsheet content was used; UK statutory rules were not applied to Jamaica.
- [ICO: sickness and injury records](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/information-about-workers-health/how-do-we-handle-sickness-and-injury-records/): separation of medical detail from routine absence records informed the private-document design. This is a design reference, not a claim that UK GDPR governs every tenant.

## Findings and changes

| Finding | Implemented behavior | Related areas |
|---|---|---|
| Every employee was treated as Monday–Friday | Charge effective scheduled days, applicable organization/location holidays, and optional employer weekday exclusions. Calendar-day policies include all dates. Preview lists exactly what will be charged. | Schedules, locations, holiday setup |
| Half-day requests could charge unscheduled/holiday dates | Validate against the selected counting basis; capture first/second half of a shift and block overlapping same-half requests. | Attendance, overnight shifts |
| Two half-days could introduce an extra minute with odd unpaid breaks | Allocate the odd net minute consistently between shift halves. | Paid/unpaid hour exports |
| Future grants appeared immediately spendable | Current balance filters by the organization's effective date. | Dashboard, team profile, HR record |
| Pending requests did not hold days | Show booked balance, pending reservations and available balance separately; serialize submission and balance adjustments. | All balance cards and decision checks |
| Final approvals could overdraw a changed balance | Recheck the effective balance and all other reservations before each approval. | Ledger, manual adjustments |
| Missing supervisor/manager could auto-approve leave | Route to an independent HR step; only explicitly configured no-approval types auto-approve. | Reporting lines, custom roles |
| NULL approver and broad manager permissions were unsafe | Current authorization, tenant membership, reporting scope, first pending step and independent reviewers are checked server-side. Revoked permissions take effect immediately. | RLS, approval queue |
| One person could fulfill multiple approval steps | A user cannot approve their own request or approve both required stages. HR can reroute pending stages without erasing completed decisions. | Escalation, HR queue |
| Supporting evidence could be bypassed and the form could not upload it | Required-evidence threshold is enforced, including a blank threshold meaning every request. Own-tenant/employee private uploads, 10 MB PDF/JPEG/PNG, scoped access and short-lived download links. | Storage, medical privacy |
| Notifications linked to a missing page | `/leave/[id]` now shows the request, charged days, policy basis, decisions, evidence, cancellation and linked balance entries. | Notification settings |
| No employee withdrawal/cancellation controls | Pending requests withdraw without posting refunds; approved cancellations require independent review and refund only the actual deduction, exactly once. | Coverage calendar, ledger |
| Past approved leave could be self-cancelled for a refund | Cancellation remains a review request; reviewer must record a reason and confirm actual absence when correcting past dates. Locked periods must be reopened first. | Approved timesheets |
| No decision reasons or cancellation outcome record | Rejection and cancellation decisions require notes; the employee sees the decision. | Employee communication, audit |
| Leave configuration was create-only and incomplete | Edit/deactivate types, choose day basis, weekday exclusions, balance tracking, notice, service eligibility, evidence, backdating and approval thresholds. | HR setup |
| Manual balance writes lacked consistent audit/retry/tenant checks | Permission-checked adjustment RPC, effective date, required reason, immutable entries and request-key idempotency. | Employee HR record |
| Opening entitlements did not provide a recurring-credit workflow | Explicit opt-in annual, monthly and per-pay-period credits, future first credit date, effective policy assignments, unique cycle keys, hourly maintenance and an HR run-due-now action. Existing policies remain opted out. | Pay calendars, employee policy assignments |
| Leave and attendance could disagree on a half-day | Approved half-shifts change expected attendance hours. Existing punches are recalculated on approval/cancellation. Full-day absence exemption requires a full day of approved leave. | Day view, exceptions, employee totals |
| Hour exports could reinterpret old leave after a policy/schedule edit | New requests capture full scheduled net minutes and a policy snapshot; exports use those paid/unpaid facts. Calendar nonworking days contribute zero scheduled hours. | Period locking, CSV |
| Sensitive reasons were shown in routine queue/register surfaces | Keep reasons and evidence on authorized details; register CSV contains operational dates/status, not medical evidence or reasons. | Team planning, reporting |
| Several failures looked like empty balances or no requests | Employee, review and setup screens show load errors explicitly. | Operational support |

## Workflow and controls

1. Employee selects a type and dates, reviews charged days and available balance, attaches required evidence, then submits with a retry key.
2. Pending tracked leave reserves days. The first valid reviewer or independent HR fallback is notified. Auto-approval is solely an employer type setting.
3. Each required stage has a different authorized person. Rejection needs a reason. A changed work calendar requires withdrawal/resubmission rather than silently altering the request.
4. Final approval posts one deduction for a tracked type. Untracked leave posts none. The employee receives an in-app notification and can inspect every step.
5. Cancellation of approved leave is reviewed before it changes coverage, attendance or balances. Repeated decisions cannot issue duplicate refunds.
6. New leave, decisions and cancellations touching a locked attendance period fail until HR reopens it through the existing audited timesheet workflow.
7. Automatic credits run only for opted-in policies and effective eligible assignments. Multiple runs cannot duplicate a cycle. Per-pay-period mode requires an effective pay group and generated pay periods.

All new public RPCs are SECURITY INVOKER wrappers over checked implementations in an unexposed
`leave_internal` schema. New evidence metadata has RLS and explicit SELECT grants. Leave sources
remain RPC-only writes; direct ledger insertion is revoked. Sensitive HR mutations honor MFA step-up.
No Supabase credentials belong in source code or browser environment variables.

## Employer configuration and explicit boundaries

- HR must configure actual employer entitlements, work schedules, location holidays and leave-type rules. A default opening grant is not a statutory calculation.
- Set the next automatic credit date after reconciling existing opening grants. Do not enable automation merely to reproduce balances already posted.
- Carryover caps, expiry/forfeiture and termination payouts remain deliberate, audited HR/accounting processes. No existing employee balance is silently expired or reset by this change.
- Use separate paid/unpaid types for different pay phases. HaloManage records approved hours and imports externally calculated pay; it does not calculate maternity pay, tax or gross-to-net payroll.
- Hourly leave, arbitrary multi-stage workflow builders, medical case management and return-to-work clearance are not advertised as implemented by this tab.
- Legacy approved requests retain their existing decisions and ambiguous half-day metadata; this migration does not retrospectively restate attendance or employee entitlements.

## Validation

536/536 database assertions pass. Both main Leave migrations and the fractional-credit
precision follow-up are applied to the HaloManage database.

The PGlite suite applies all migrations to Postgres with real RLS and impersonated employees,
supervisors, HR and another tenant. Coverage includes schedule/holiday counting, reservations,
retry-safe grants/submission, independent decisions, privacy, cancellation, revoked access,
locked periods, half-shift attendance and exports, repeat-safe recurring credits, and fractional credits such as 1.25 days per month.
Frontend validation includes lint (existing warnings only), TypeScript, client/server boundary checks and a production build.
Authenticated live database smoke checks use transactions that roll back all temporary records.
A live authenticated browser click-through of the new screens is not represented by these database/build checks.
