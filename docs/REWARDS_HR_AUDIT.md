# Rewards — HR and engineering audit

Reviewed 25 October 2026 (America/Jamaica). Scope: employee Rewards, HR catalog administration, awards/corrections, redemption/fulfillment/refunds, privacy, eligibility, notifications and Recognition correlation. Code ships through GitHub main. Railway is not operated manually.

## Research and product decisions

- [CIPD: Incentives and recognition — evidence review](https://www.cipd.org/en/knowledge/evidence-reviews/evidence-financial-incentives) recommends job-appropriate rewards, a clear link to contribution and fair administration. HaloManage now requires employee-visible reasons for awards and corrections, prevents self-awards, records decisions and offers operational history. Employers remain responsible for consistent criteria, equitable access and reviewing decisions; these controls do not prove fairness by themselves.
- [CIPD: Reward — an introduction](https://www.cipd.org/en/knowledge/factsheets/reward-factsheet/) considers both financial and non-financial rewards and employee needs. The catalog supports employer-curated local suppliers and internal perks with clear collection and expiry terms. It does not assume one gift-card provider, a cash conversion rate or a mandatory benefit package.
- [Jamaica Office of the Information Commissioner: Data Protection Standards](https://www.oic.gov.jm/page/data-protection-standards) informs limited access and appropriate security. Vendor contacts are restricted to catalog/fulfillment staff. Reporting-line permissions alone no longer reveal employee points or redemption choices. General notification bodies omit award reasons and fulfillment instructions.
- [Jamaica Court of Appeal, Commissioner of Taxpayers Audit and Assessment v Hosang, 2020 JMCA Civ 53](https://www.courtofappeal.gov.jm/sites/default/files/judgments/Commissioner%20of%20Taxpayers%20Audit%20and%20Assessment%20%26%20anor%20v%20Hosang%20%28Hason%29%20et%20al.pdf) discusses the broad statutory concept of employment emoluments, including benefits. This is a reason to require employer/payroll review rather than label catalog rewards tax-free. HaloManage does not calculate tax, deduct salary or automatically put rewards into imported payslips. Applicability and valuation require current employer-specific advice.

These are design inputs, not a legal certification. A reward described as time off still needs the normal Leave policy and approval process; collecting a perk never creates statutory leave or changes attendance, appraisals or contractual pay automatically.

## Findings and implemented fixes

| Gap | Resulting behavior |
|---|---|
| Repeated requests could duplicate awards or spend points twice | Payload-bound UUID retry keys for new award/redemption forms; a matching retry returns the original record |
| Confirmation could silently use a changed cost or terms | Redemption checks the reviewed points cost and product version before committing |
| History joined mutable catalog names | Receipts snapshot reward/vendor labels, description, terms, cost and whether stock was reserved |
| HR had creation-only catalog forms | Create, edit, archive, reactivate, publish terms and update available stock; edits reject stale versions |
| Supplier contacts were readable by ordinary members | Employee catalog RPC returns only necessary reward fields; direct vendor access is scoped to catalog/fulfillment roles |
| General team access exposed personal reward choices/balances | Employee self-access plus explicit Rewards operational permissions; no reporting-line shortcut |
| Pausing the feature hid outstanding obligations and history | Paused programs preserve employee history/balances/cancellation and HR settlement/correction access |
| HR could not correct an erroneous award through the UI | Award history plus exact append-only reversal with an employee-visible reason; replacement is a new award |
| Cancellation/failure bookkeeping lacked source-level safeguards | One original-cost debit and at most one exact refund per receipt, with deferred reconciliation constraints |
| Stock tracking could change under pending requests | Reserved-stock snapshot and a guard against switching tracking mode while requests remain pending |
| Fulfillment had optional unexplained outcomes | Required employee-visible completion/cancellation/failure explanation, terminal state protection and retry-safe outcomes |
| Employee history omitted completion instructions | Receipt view shows collection instructions, cancellation/failure reason, resolution date and reference |
| History stopped after a small recent slice | Searchable catalog, paginated receipts/points, filtered HR requests and paginated award/correction history |
| Backend controls did not consistently match UI gates | Feature, role, tenant, employee-status, MFA and sensitive-action checks in the database |
| Active automatic-provider records could imply nonexistent delivery | Employee catalog/redemption supports manual fulfillment only; no unimplemented API reward can consume points |

## Employee workflow

Active employees and employees on leave can use their permitted Rewards features. Prehire, suspended and terminated records are ineligible. Former employees' outstanding obligations remain visible to authorized HR for settlement; this release does not introduce former-employee portal access.

Employees search the catalog, inspect terms and confirm a specific cost. A successful request deducts points and reserves tracked stock immediately. The receipt keeps the original terms even if the catalog is later edited or archived. Employees can cancel their own pending manual requests with a reason. HR can complete, cancel or mark a request unable to fulfill. Cancellation/failure returns the exact original points cost and restores the original stock reservation once. Fulfilled requests are final in this workflow; cancellation cannot claw back a delivered external benefit.

Notifications point to the employee's own receipt. A guessed reference cannot expose another person's request. The complete points history links related redemptions and Recognition records. Recognition deep links continue to apply their own audience and removed-content rules.

## HR administration and accountability

`rewards.manage_catalog` controls vendors/products. `rewards.award_points` controls documented awards, exact corrections, relevant employee search/balances and award history. `rewards.fulfill` controls request resolution and operational balances. Each can be granted independently; limited roles receive useful employee display names through scoped RPCs without requiring unrestricted employee-directory access. Vendor contacts remain available only to catalog/fulfillment staff, not points-only staff.

Self-awards are blocked. New awards require 1–1,000,000 points and a reason of 3–1000 characters. Corrections append the full negative amount once and retain the original award/reason. A correction can leave a negative Rewards balance if points were spent. HR should discuss affected requests, decide any replacement award and use pending-request cancellation where appropriate. This does not deduct salary or automatically reverse an already delivered benefit.

Catalog names, descriptions, HTTPS image URLs, contacts, cost, terms and stock are validated. Case-folded vendor names and per-vendor reward names prevent duplicate catalog entries. Stock edits use optimistic version checks to avoid overwriting concurrent reservations. Catalog identity/creation history is immutable; edits and stock movement are audited through their associated operations. Archiving preserves historical receipts and outstanding requests.

The queue shows pending counts and the oldest request, with status/search filters and full outcome history. Negative-balance counts identify cases for review; they are not a misconduct finding. Program activation remains in the existing platform feature controls rather than becoming an employee-accessible switch.

## Accounting, security and integration

The existing append-only ledger remains the single balance source. Unique source indexes and integrity triggers reject duplicate/wrong-amount/wrong-employee debits, refunds and award corrections. Deferred constraints require every receipt to reconcile with exactly one original debit and the correct refund count. Recognition credits/reversals retain their previous independent source constraints and reconcile in the same balance. Giving allowance remains separate from spendable points.

Spending, refunds and award corrections take the same employee balance lock used by Recognition reversals before locking receipts/products. The old product-first spend implementation is retired from authenticated execution. Stock changes run only through protected receipt-trigger paths; client-set flags never authorize inventory movement. Catalog editing serializes on its row and checks the version reviewed by HR.

Privileged implementations live in unexposed `rewards_internal`; public API wrappers use `SECURITY INVOKER`. Anonymous execution is revoked, search paths are fixed and relevant table grants/RLS are explicit. Employee reads remain available during a program pause, but required MFA still applies. Awards, spending, catalog edits, resolution and corrections apply sensitive-action step-up policy. Permission revocation takes effect through database authorization rather than trusting a client button.

Rewards routes use private/no-store, no-index and no-referrer headers. Native dialogs provide browser-managed focus and Escape handling; busy submissions disable dismissal and duplicate clicks. New supplier images use HTTPS and omit the referrer.

## Validation and remaining boundaries

- **817 regression assertions passed**, including 96 Rewards-specific assertions and all earlier Recognition/Leave/My Pay/Attendance checks.
- All migrations apply cleanly under Postgres/PGlite. Tests cover tenant/role separation, inactive employment and leave access, supplier privacy, validation, retry mismatch, snapshots, stock, refunds, corrections, pause behavior, MFA, permission revocation and pagination.
- TypeScript and client-boundary checks pass. Lint has zero errors and nine existing warnings. The production build passes.
- Live migration `20261026000736_rewards_hr_workflow.sql` is recorded in Supabase migration history. A live authenticated-role smoke transaction tested award/redemption retries, safe catalog projection, paused history, employee cancellation, award correction and forced deferred reconciliation; it passed and was rolled back. Live products, redemptions and points-ledger row counts remained zero.
- Live security advisories decreased from **146 to 142**, with **no new findings**. GitHub CI runs the database and web checks for the main release commit; its status is verified before reporting completion.

PGlite and the rollback smoke do not certify actual signed-in browser interactions, outbound email/SMS delivery, multi-session load behavior or Railway auto-deployment. The locking order is reviewed, but no concurrency stress-test claim is made. Previously existing receipts, if any, can only be backfilled from the current catalog; the migration does not invent old labels. This production project had no existing catalog or Rewards transactions at migration time.

Manual fulfillment is intentional. Automated gift-card providers, external financial reconciliation, partial post-fulfillment returns, employer-specific approval budgets, automatic point expiry and benefit-tax exports remain separate work. No external provider APIs or payroll-engine behavior are added. Employer retention/legal-hold and access policies still apply.
