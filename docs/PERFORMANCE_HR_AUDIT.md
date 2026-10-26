# Performance HR review — 25 October 2026

This review covers Performance (`/appraisals`), cycle/template administration, dashboard tasks, employee HR records and scoped Team history. Migrations: `20261026014038_performance_hr_workflow.sql` and `20261026022519_performance_retry_state_policy.sql`. Dates are recorded in the organization's timezone; this release was prepared on 26 October UTC / 25 October in Jamaica.

## Research and HR decisions

Primary sources checked on 25 October 2026 (Jamaica):

| Source | Finding used | Product decision |
| --- | --- | --- |
| [Acas: Reviews and appraisals](https://www.acas.org.uk/performance-management) | Review strengths, improvement, support and development; share written records and set clear, measurable objectives. | Preserve review-period questions and feedback; track success criteria, target dates, support and progress. |
| [CIPD: Performance management — Could do better?](https://www.cipd.org/uk/knowledge/evidence-reviews/what-works-in-performance-management/) | Feedback and perceived fairness matter; objectives should fit task complexity; developmental and administrative conversations serve different purposes. | Employee comments/disagreement and HR follow-up; configurable questions rather than a universal score; development stays separate from pay decisions. |
| [CIPD: Performance feedback evidence review](https://prod.cipd.org/en/knowledge/evidence-reviews/performance-feedback/) | Feedback can help or harm depending on delivery. | Ask reviewers for specific period evidence and support needs; retain context rather than rank employees by popularity or raw activity. |
| [Acas: Problems with performance](https://www.acas.org.uk/performance-management/problems-with-an-employees-performance) | Understand causes and consider support or training before deciding how to respond. | A low rating does not automatically trigger discipline, termination, leave changes or failed probation. |
| [Jamaica OIC: Data protection standards](https://www.oic.gov.jm/page/data-protection-standards) | Purpose, minimization, accuracy, access controls and retention require organizational attention. | Author-only drafts, scoped access, visible corrections, minimal notifications and preserved decision history. |

These are operational design choices. Acas/CIPD material is not presented as Jamaican employment law. A receipt is neither agreement with a rating nor a certified legal signature. HR must set suitable role-specific expectations, review support needs and operate the employer's grievance, retention and disciplinary policies. The release does not certify legal compliance or invent a statutory review frequency/retention period.

## Findings corrected

| Original gap | Implemented behavior |
| --- | --- |
| Launch query ignored employee targeting. | Validated filters combine across employees, units, positions, employment type and eligible status. HR previews the roster before launch. Foreign/unsupported IDs are rejected. |
| Draft responses were visible to the employee, later reviewers and HR. | Only the eligible author sees a draft. Earlier submitted stages are available to later assigned reviewers and HR. Employees receive others' feedback after independent stages finish. Retry bodies live in an unexposed private table. |
| Empty or out-of-order reviews could advance. | Current-stage authorization, typed answers, snapshot-specific rating values, numeric bounds, choices and required fields are checked atomically in the database. |
| Historical checkpoints depended on editable source questions. | Launch copies template, scale, sections/questions, employee label, period, opening date and deadlines. Submitted responses and closed stage records cannot be rewritten. Archive source records instead of deleting them. |
| Direct upserts permitted weak response/checkpoint correlation. | RPC-only review writes, source checks, version checks and payload-bound retry keys. Clearing an answer removes it from the saved draft. |
| Missing or obsolete reviewers could strand a checkpoint. | Eligibility is checked against current active/leave accounts, permissions and scope. HR can retire a pending stage with a reason and assign a valid replacement; retired stages/drafts stay retained. At least one independent submission is required before release. |
| Acknowledgement suggested agreement. | Employee chooses receipt, comments or disagreement. Disagreement opens HR follow-up. Shared HR responses/amendments preserve the original assessment. |
| Goals were untracked free text. | Self-review goal proposals carry success criteria, date and support into a development plan. Independent leaders agree and confirm achievement; employee progress and prior terms remain in event history. |
| Dashboard used a nonexistent relation column and active counts checked incorrect statuses. | Dashboard shows genuinely actionable stages by `instance_id`; `complete` and `cancelled` checkpoints leave active counts. Employee/Team/HR history links use the same records. |

## Workflow and access

1. HR creates an active template with questions, rating labels, required fields and optional structured goals. Template, section and question changes affect future launches only.
2. HR creates a dated draft cycle, sets deadlines in stage order, selects a roster and previews it. Empty results fail explicitly. A launch retry returns the existing instances.
3. Linked active/leave employees hired by the review-period end are eligible. Terminated/prehire and unlinked accounts are excluded. Target department/position/employment filters use assignment at period end; reviewer routing uses current effective reporting lines. The same supervisor/manager creates one independent stage. If no leader account exists, independent HR review is retained; an HR subject cannot review themselves.
4. Self-review precedes supervisor and manager/HR stages. Each author can save private drafts or submit a final review. Required data and types are validated on submission. Stale browser versions fail without overwriting newer work. Cycles cannot be answered before their organization-local opening date; due dates are guidance and remain visible rather than locking an employee out after a missed deadline.
5. Combined feedback is released only after independent review. The employee records receipt and can disagree. HR may add a shared response or amendment and resolve the query without changing original ratings. New employee comments can reopen follow-up.
6. Proposed development goals can be discussed and edited. An independent authorized leader activates them and confirms achievement. Version checks protect updates; append-only events preserve prior terms and progress. Closing the appraisal does not prevent continued goal work.
7. HR closes a cycle after every instance is complete/cancelled, or cancels unfinished checkpoints with a retained reason. Completed records remain intact; their follow-up can continue even if the rest of the cycle was cancelled.

`appraisal.manage_cycles` controls administration; `appraisal.review_direct_reports` additionally requires current management scope; `appraisal.complete_self` controls self-review and receipt. A current assigned reviewer needs the appropriate role/scope. Performance-only HR can select minimal employee labels without broad directory access. Current eligible organization membership, network policy and required MFA protect reads; sensitive mutations honor the existing step-up policy. Anonymous execution is revoked. Public RPCs are invokers over guarded implementations in unexposed `performance_internal`; table RLS independently protects direct reads and denies client state changes.

## Correlation and deliberate boundaries

- Dashboard, personal history, HR cycle queues and employee/Team cards link to one checkpoint and its immutable responses. Cycle results distinguish complete, cancelled, open queries and reviewer eligibility issues.
- Notifications contain a record link and generic task text, never draft answers or ratings. Appraisal routes return private/no-store, noindex and no-referrer headers.
- Previous released checkpoints are linked as context; ratings from different recorded scales are not combined automatically. Recorded question weights are preserved but do not generate a fabricated overall score.
- Onboarding/training completion, attendance, approved leave and Recognition/Rewards points do not become automatic performance penalties, rankings, salary changes, or probation decisions. HR can consider relevant evidence and context through configured questions. Pay continues to be calculated externally.
- Recurring cycles are created/reviewed manually; there is no hidden scheduler. Anonymous 360 feedback, attachments, calibration/ranking, exports and a formal disciplinary/PIP workflow are not claimed as implemented.
- History is retained and corrections are append-only in the operational UI. Organization-specific retention/disposal, subject-access requests, legal holds and privacy notices still require the employer's policy and an authorized process; this migration creates no automatic purge.
- No new third-party service or external performance API was added. Railway was not operated.

## Validation

- 1,014 PGlite database/application assertions pass, including 95 new Performance checks and the existing cross-module regressions. Performance tests cover filters, private drafts and raw-table RLS, all six answer types, required fields, payload retries, stale saves, immutable snapshots, sequential release, independent goal decisions, disagreement, shared amendments, closure/cancellation, reviewer recovery and role revocation, employee history, network/MFA/step-up and anonymous boundaries.
- Web TypeScript, lint (0 errors; 9 pre-existing warnings), client-boundary verification and Next.js production build pass.
- Both migrations were applied transactionally to the connected HaloManage Supabase project and recorded in migration history. The authenticated-role live smoke passed and rolled back all fixtures: cycle/instance/response/goal/message counts remained zero. It exercised roster/launch retries, private drafts and raw-table access, stale saves, frozen questions, independent release, disagreement, goal agreement/progress/achievement, HR amendments and cycle closure.
- Supabase security findings fell from 124 to 118 with no new findings after the explicit deny-all retry-table policy. Existing unrelated findings remain outside this release.
- GitHub Actions runs the database and web checks for the release commit; the final release report links that exact commit after CI verification.
- No signed-in production browser walkthrough, Railway deployment confirmation, concurrent load test or external legal certification is claimed.
