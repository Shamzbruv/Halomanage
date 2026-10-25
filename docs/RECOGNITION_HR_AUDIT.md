# Recognition — HR and engineering audit

Reviewed 25 October 2026 (Jamaica). This review covers the employee Recognition tab, HR administration, company values, employee privacy, reporting/moderation, notifications, employment eligibility and the connection to Rewards. Changes ship through GitHub main; Railway is not operated manually.

## HR research and product decisions

- [CIPD: Incentives and recognition — evidence review](https://www.cipd.org/en/knowledge/evidence-reviews/evidence-financial-incentives) emphasizes rewards suited to the work, a clear relationship to contribution and perceived fairness. HaloManage asks for a concrete contribution and impact, supports employer-defined values and keeps kudos available without points. Giving budgets, limits and moderation decisions are auditable. Participation counts support HR review; they do not establish performance, misconduct or equal opportunity by themselves.
- [CIPD: Practice summary](https://www.cipd.org/globalassets/media/knowledge/knowledge-hub/evidence-reviews/incentives-recognition-practice-summary_tcm18-105466.pdf) distinguishes fairness of distribution from fairness of the process. HR can review program reach, values, private/public activity, reports and reversals. The implementation avoids an employee popularity leaderboard and does not automatically turn recognition counts into appraisal scores, promotions or salary changes.
- [Jamaica Office of the Information Commissioner: Data Protection Standards](https://www.oic.gov.jm/page/data-protection-standards) describes minimization, accuracy, access rights, appropriate security and retention. Audience wording now reflects actual access. Employees can keep recognition private, change existing public messages addressed to them to private, and report concerns confidentially to authorized HR reviewers. New notification bodies omit the message. An employer still needs a lawful HR policy, privacy notice, retention/legal-hold procedure and appropriately assigned reviewers; application features alone do not certify compliance.

These sources inform product choices. They are not a claim that every employer must use the same recognition scheme, points limit or moderation policy.

## Findings and fixes

| Gap | Implemented behavior |
|---|---|
| Reading recognition depended on being allowed to give it | Separate read, give, manage and moderate permissions; established giver bundles remain readable |
| Private praise was described as only for the recipient | Audience is accurately described as giver, recipient and authorized HR moderators |
| Points-awarding authority implicitly exposed all private praise | Private review now requires explicit recognition moderation authority; ordinary points awarders do not inherit it |
| Inactive/prehire/suspended employees could participate through older RPC checks | Giving and receiving require eligible active or leave status within the same organization |
| Ordinary employees could not reliably populate the coworker list through directory RLS | A scoped search returns only necessary coworker identifiers, display names and audience preference |
| The first coworker/value was selected automatically | The sender explicitly chooses a coworker; value is optional unless policy requires one |
| A foreign or archived recognition value could be supplied | Posting checks value ownership and active status in the database |
| Existing messages changed meaning when labels or names changed | New records snapshot display names and the value name; preferred names are respected |
| New organizations received settings but no starter values | Workspace provisioning now supplies usable, editable starter values |
| Daily/monthly counters used the database timezone | Counters and displayed reset dates use organization-local day/month boundaries |
| Kudos-only posts could race the daily count | Every post acquires the giver lock before retries and limit checks, including zero-point posts |
| Retries could post a second recognition and award points twice | New clients use a payload-bound retry key and a unique giver/key constraint |
| Nothing let employees choose private recognition or report a problem | Employee preference, per-record privacy control and a confidential, paginated report history |
| No accountable content correction/removal workflow | HR records an explanation, resolves reports and can remove a recognition without rewriting the original message |
| Recognition and points could diverge | Deferred database checks require exact credit/reversal correspondence; unique indexes prevent duplicate credits/reversals |
| Financial evidence could be overwritten | Recognition content/awards and the Rewards ledger are immutable through ordinary workflows; moderation evidence is append-only |
| Recognition settings were trapped behind the Rewards feature gate | `/admin/recognition` works for kudos-only programs independently of reward redemption availability |
| The UI gated Rewards while backend paths could ignore the feature | New point-bearing recognition and reward redemption enforce the feature and relevant permissions server-side |
| Sensitive-action MFA policy was inconsistent around points | Point-bearing recognition, redemption, policy administration and moderation apply the sensitive-action step-up rule; required MFA also protects recognition reads |
| History was limited to a small recent feed | Organization/local-date/value filters, separate public/given/received views, pagination and working notification links |
| HR had no program-health or report-review screen | Dedicated policy/value administration, confidential reports and aggregate program-health metrics |
| Partial employee imports reset missing status to prehire | Updating a directory record without a supplied status now preserves its existing status, preventing accidental loss of Recognition access |

## Employee workflow

Recognition can be a message alone. Points are optional and require both an enabled Rewards program and an HR-configured giving allowance. A giving allowance is separate from an employee's spendable Rewards balance. It resets at the next organization-local month boundary, does not carry forward, and cannot be replenished by repeatedly removing gifts. Daily limits count all posts, including posts later removed. The default system ceiling is 100 posts per giver per local day; HR can set a lower limit and a limit on monthly points from one giver to one recipient.

The sender selects a coworker, optionally selects a value, explains the contribution, and chooses the audience. If the recipient prefers private recognition, the server forces private visibility even when a client requests the organization feed. The privacy preference and posting path share a recipient lock, preventing a concurrent send from slipping through a preference change. Switching privacy off for public praise also privatizes earlier public recognition addressed to the employee. Switching public recognition back on does not republish earlier private content.

Private recognition is not a secret channel outside the employer's HR process. Authorized moderators can review it. The personal feed does not automatically fill a moderator's home screen with other employees' private messages; the HR view provides explicit review access. Reports and reporter identities are restricted to the reporter and authorized moderators.

Employment status is checked in the database. Employees on leave remain eligible; prehire, suspended and terminated records do not give or receive new recognition. This does not automatically change an employee's contractual status or the employer's leave policy.

## HR correction and points accounting

A report is a review request, not a finding of wrongdoing. HR can retain the recognition and close reports with an explanation, or remove it with an explanation. Removal is permanent in the ordinary workflow. Historical content remains available to authorized moderators, while employee links show a safe removed status without the removed message. A corrected appreciation should be a new, appropriately reviewed record rather than an edit to old evidence.

If a recognition carried 20 points, removal appends exactly −20 points to the recipient's ledger. It never rewrites the original +20. Removal retries cannot create a second reversal. Original giving allowance remains consumed, so a giver cannot recycle a budget by repeatedly removing recognitions.

If the recipient already spent the points, their Rewards balance can become negative. The interface explains this. New redemptions fail the balance check. HR must inspect pending redemptions and may cancel them through the existing cancellation/refund workflow. A pending 20-point redemption followed by a −20 recognition reversal and then its +20 cancellation refund reconciles to zero; it does not create extra points. Fulfilled external benefits are not automatically clawed back. These are Rewards adjustments, not salary deductions or payroll calculations.

## Administration, access and records

- `recognition.read` reads eligible employee recognition; `recognition.give` posts it; `recognition.manage` controls policy/values; `recognition.moderate` reviews private content/reports and decisions. Existing Rewards catalog managers retain policy-management compatibility. Existing built-in administrator overrides are migrated to retain their previous administration scope; custom roles should receive explicit moderation permission when appropriate.
- New privileged implementations live in unexposed `recognition_internal`. Public RPCs use invoker wrappers and deny anonymous execution. The old giving endpoint remains compatible; retry protection is provided by the new sending endpoint used by the web form.
- New tables have RLS and explicit Data API SELECT grants. Writes go through scoped RPCs. Direct legacy policy writes receive the same validation and audit trigger where privileges already allow them. Values are archived rather than deleted, and pausing a program retains readable history.
- Moderation and notification events are connected to the existing in-app notification system. Message bodies and report reasons are not copied into generic notification bodies. This release does not certify outbound email/SMS provider delivery.
- Program reports show historical posting-period counts and a current eligible-employee denominator. They do not calculate an historical workforce snapshot or automatically attribute differences to bias.
- Recognition and its administration routes are dynamic and use private/no-store, no-index and no-referrer headers. The compose form uses a native dialog for keyboard focus and Escape behavior.
- The partial employee-import fix changes only the missing/blank-status fallback on updates. New imported employees still default to prehire. Explicitly supplied status changes continue through the established import validation path.

## Validation and release boundaries

The regression suite applies all migrations to real Postgres/PGlite, including RLS, permissions, RPCs, deferred constraints, triggers, default workspace provisioning and the partial employee-import update. Recognition-specific cases cover tenant isolation, private access, role separation/revocation, inactive employment, leave eligibility, preferred names, value validation, policy/feature gates, payload-bound retries, audience preferences, report confidentiality, moderation, exact ledger reversal, spent points and refund reconciliation, required MFA and sensitive-action step-up.

Local database tests exercise transactional behavior; PGlite is not a multi-session concurrency stress test. The locking order is reviewed separately. Live smoke checks are performed inside a transaction that is rolled back, leaving no demonstration recognitions, ledger entries or reports. Browser acceptance under actual employee/moderator accounts and Railway auto-deployment are not certified by these checks.

Deferred areas remain explicit: badges/levels, approval-before-publication, automated collusion detection, payroll/tax treatment of benefits, external reward-provider fulfillment and employer-specific records-erasure/legal-hold operations. Recognition does not automatically modify attendance, leave balances, appraisals, contractual pay or payroll.

Release checks: 721 regression assertions passed. Web lint has zero errors and ten existing warnings; TypeScript, client-boundary checks and the production build passed. Live migration, rollback smoke and security-advisor comparison are release gates, together with GitHub CI on the main commit.

The live giving/retry/report/removal/privacy smoke transaction passed, including forced deferred ledger checks, and was rolled back. The security-advisor comparison changed from 149 to 146 advisories with no new findings. No real recognition or Rewards entries were retained from validation.
