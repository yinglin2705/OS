# Career Agent — architecture, deployment and operating guide

## Repository audit and implementation plan

Audit: 2026-10-19. Existing architecture: Next.js 15 App Router, TypeScript/React, Supabase cookie authentication (`lib/server.ts`) and browser client, private owner RLS, six SQL migrations, Vitest, isolated PostgreSQL tests and Chromium fixtures. Vercel hosts the app. Existing board migrations use GitHub Actions and Supabase Management HTTPS SQL; Telegram functions and minute Cron have their own deployment. No existing career-profile or job tables. Calendar's `career` category is an event classification, not an application tracker.

Implementation sequence:
1. Add isolated career tables in migration 007; do not change existing tables, notification jobs or personal events.
2. Store individual profile claims with original evidence and explicit human verification. Parse JD text with source quotes and unknown values preserved; calculate transparent evidence coverage.
3. Add authenticated `/career` dashboard and same-origin server APIs. Restrict drafting using documented employer AI-policy decisions and verified claims. No submit/email endpoint.
4. Discover roles through explicitly approved official Greenhouse Job Board APIs, using GitHub Actions, bounded requests and deduplication. No general website scraper.
5. Test authorization, policy gates, extraction/matching, discovery bounds, SQL privacy and UI; document deployment/configuration separately from live validation.

The database remains authoritative. Personal profile evidence is never sent to a job board or stored in GitHub. No credentials, real CVs or application data belong in the repository.

## Re-audit and hardening plan — 2026-10-21

Reused the existing module rather than adding a second tracker. Audited migrations001–009, the cookie-authenticated API, source approvals, private profile storage, deployment007, daily discovery workflow, and existing SQL/browser tests. Found URL-only discovery identity, no persisted match runs, stale source text not detected, and client-only draft export checks.

Implemented additive migration010 and isolated module changes:
1. Preserve application progress and saved JD text; deduplicate by provider source/external ID before URL. Record private provider observations, flag changed job context, and require explicit adoption/re-review. Source approval is rechecked under a database lock against the exact approval timestamp used to start discovery. Adoption is pinned to the observation the user previewed, rather than silently swapping in a newer feed result.
2. Close only availability (never application status) after a complete feed proves an external ID absent. Retain all feed IDs before candidate filtering/capping. Incomplete feeds cannot close jobs.
3. Add approved-source Lever alongside Greenhouse, with the same fixed-host/robots/rate/response limits.
4. Persist analysis, profile/job evidence and matching snapshots; show/deletable recent match history. Withhold keyword credit for negated experience, unsupported year requirements, non-education evidence for degrees, and eligibility decisions.
5. Use a database policy/evidence gate for draft creation and Markdown export. Employer/title/URL/JD changes invalidate policy approval. Changed/closed source listings block drafting/export. Different evidence-template structures support CV, cover letter and statement; they deliberately require personal motivation and final editing.

## Implemented MVP

- `/career`: Chinese-first shortlist, text/status/flexibility filters, Master Profile, source approvals, private discovery logs, JD analysis, evidence matches, application status/history and immutable draft versions.
- Profile claims: skill/experience/education/availability/eligibility, original text, optional URL, keywords, unverified/user-verified/rejected state and verification timestamp. No seeded personal claims.
- Manual JD intake preserves full text and source URL. Explicit essential/desirable sections and requirement language produce quoted requirements. Full-year dates only; no invented time of day. Weekly hours are extracted only when explicit. Eligibility text is flagged, not decided.
- Matching uses only verified claims with matching keywords present in both claim and evidence. Weights: essential 75, desirable 15, explicit flexible/part-time 10; absent requirement categories are removed from the denominator. Without extracted requirements, no score is assigned. This is lexical evidence coverage, **not proof of full eligibility, semantic fit, or probability of an offer**. Experience-duration requirements still need human review.
- AI-policy layer: unknown, allowed, analysis-only, prohibited. Drafts require a human-reviewed policy URL and quote, verified selected claims and explicit approval. Restrictive signals in policy **or JD** block generation even when the user chose “allowed”. A changed JD invalidates policy approval. A database RPC enforces the same restrictions for direct clients.
- CV / cover letter / personal statement **evidence templates**, selected per role, retain immutable source/policy/JD-analysis snapshots. Version counters do not reuse deleted numbers. This MVP does not call an LLM or write polished personal prose. Applicants supply their own motivation and review every fact before using/exporting the draft.
- Progress is exclusively manual. Marking “applied” records the user's action; the app never submits, emails, uploads to ATS, or changes status because it made a draft.
- Every career record type can be deleted. Deleting an opportunity cascades its draft versions and history. Deleting a claim does not erase evidence snapshots in existing drafts: delete those versions too for complete removal. Deleting a source preserves saved opportunities. Account deletion's existing user cascade also removes career data. No career deletion affects the calendar.

## Discovery adapter and approvals

Adapters use the **official Greenhouse Job Board API** (`https://developers.greenhouse.io/job-board.html`) and **Lever Postings API** (`https://github.com/lever/postings-api`). It is a per-employer feed, not a search engine for the entire London jobs market. No websites are scraped. Other ATS/aggregator adapters and Lever EU-hosted feeds are not implemented.

In “发现来源与运行记录”, enter the employer name and provider and actual employer board/site token, creative-sector keywords, terms URL and a meaningful terms-review note. Confirm approval and enable discovery. Confirm that the employer/API terms permit the intended use; the checkbox is a human attestation, not an automated legal conclusion. Nothing is fetched from a job board until a source is explicitly enabled and approved. Disabling or deleting it stops future fetches; requests already in flight may finish.

The runner checks API-host robots first. Disallowed paths, unavailable robots other than404, positive crawl-delay requiring review, redirects, oversized responses and429 are not bypassed. Only fixed official HTTPS API hosts (`boards-api.greenhouse.io`, `api.lever.co`) are permitted. Two bounded API requests per source; at most six sources/run, 100 matching roles/source, with sources rotated by oldest run and a delay between sources. 429 does not get immediate retries. Do not use alternate domains or proxies to bypass a restriction.

Filtering keeps London or explicitly UK-remote creative roles and prioritises explicit part-time/flexible signals. Full-time creative roles can still appear. Known past deadline dates are excluded. Unknown deadlines are preserved. API appearances store UTC `last_seen_at`; the UI renders Europe/London and flags entries unseen for seven days. **Listed does not certify that the employer is still accepting applications.** Always inspect the original page manually.

Stable provider IDs deduplicate within each source, with per-user canonical URLs as a fallback. Tracking parameters and URL fragments are removed. Discovery preserves saved JD text, notes, drafts and application status, while refreshing availability and source observations. When source text/context changes, preview and explicitly adopt the latest observation, then review policy again. Only a complete feed can mark an absent external ID closed; no records are deleted. The shortlist hides known closed/past-deadline entries by default, with an option to include them. Unknown deadlines are not assumed open or closed.

## Deployment

1. Existing prerequisites: Supabase migrations001–006, Next/Vercel environment (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`), working authentication. No new model/API key is needed.
2. Apply `supabase/migrations/007_career_agent.sql` followed by additive `010_career_hardening.sql`. `.github/workflows/deploy-career.yml` does this automatically when its paths are pushed to main, using the existing **GitHub repository secret** `SUPABASE_ACCESS_TOKEN`. It uses Supabase Management HTTPS SQL, matching this repository's established convention. No database password or personal profile is copied to Actions.
3. The script defaults to the existing project ref; use `SUPABASE_PROJECT_REF` for another deployment. The migration creates only career tables/triggers/RPCs and grants; it does not alter existing OS tables, Cron, Telegram secrets, or user schedules. It is transactional and safe to repeat. Successful workflow notice verifies all eight RLS tables and restricted draft access.
4. Vercel's existing Git integration builds `/career` and `/api/career`. Wait for that deployment before opening the new module. Its deployment status is separate from schema success.
5. `.github/workflows/career-discovery.yml` runs daily **06:17 UTC** (London06:17 winter,07:17 summer), with manual dispatch supported in GitHub → Actions → “Discover approved career opportunities” → “Run workflow”. This is a discovery schedule, not a change to the OS notification schedules. GitHub scheduled runs may be delayed, disabled for repository inactivity, or require enabling Actions for forks.
6. Approve a real source in the dashboard, then manually run discovery once. Verify its private run log and a real employer source. Until that succeeds, live job discovery is **not verified**. No approved source means no outbound job-board API request.

Secrets stay in environment settings/Actions secrets. Do not paste secrets into chat, source forms, commits or logs. Profile/CV evidence stays in Supabase; the runner reads source settings and public role feeds only. Management PAT is privileged: keep workflows restricted to trusted main commits; it is never exposed to Next.js client code.

To roll back the UI, revert the relevant career UI commit while leaving additive tables intact; do not drop personal career data. Destructive schema cleanup needs explicit approval and a backup. Review migration diffs before deployment.

## Validation

- `npm test`: analysis and policy gates; unknown fields and source quotes; matching; bounded official API requests; robots/rate limits; mocked complete CLI; authentication, approval, record-type bounds and request-size limits.
- `npm run test:db`: isolated PostgreSQL17; applies007 and010 twice; verifies owner isolation, forbidden direct draft inserts, policy/foreign-evidence denial, invalidation on JD changes, versioning, history, deletion/account cascade. Existing calendar/notes/notifications tests also run. A pre-existing rollback test fixture was completed and deterministically ordered so it actually reaches its intended review conflict rather than failing on missing source fields.
- `npm run build` and `npm run typecheck`.
- `YING_BROWSER_BASE_URL=http://localhost:3102 node scripts/test-career-browser.cjs` against a running local production build. All user data and network responses in this test are fixtures; no real CV or applications are sent.

Local/mocked tests do not prove live source permission, real employer AI-policy validity, actual eligibility, Vercel deployment or real job discovery. Track those checks separately. The MVP does not include general web search, autonomous browsing, semantic LLM matching, PDF CV extraction, polished prose generation, employer-policy legal interpretation, calendar deadline creation, application auto-submission or outbound email.

## Release verification and remaining limits

Run `npm test`, `npm run typecheck`, `npm run test:db`, `npm run build`, then the fixture browser script against a local server. Database tests use an ephemeral PostgreSQL container and roll back fixtures. No real profile data or approved live job sources are required for these checks. The deployment script applies007 then010 atomically in one transaction, so replaying007 cannot temporarily restore the older policy RPC.

After schema deployment, use `/career` → Master Profile to add evidence and explicitly verify each fact. Save a real JD manually, inspect extracted quotes and unknown fields, review employer AI policy, select only relevant verified claims, preview a draft, and explicitly export. For discovery, approve an actual employer API source and terms before running the existing daily workflow manually. Check its private log and compare a stored listing with the employer's current page. GitHub Actions is the only career scheduler; no extra Supabase Cron is created.

Automatic parsing and matching remain conservative lexical rules, not semantic verification. A year count is only a screening safeguard, not proof the years relate to the required skill. Compound requirements and degree levels still need human review. Historical drafts remain readable by their owner even when download is blocked; the gate cannot prevent manual copying. Match history displays the last20 snapshots and documents the last100 versions; deletion through the owner API is available for all career record types. Broader search, policy interpretation, polished generative writing, ATS submission and email delivery are not implemented.

Local verification on2026-10-21: production build and TypeScript passed; fixture Chromium verified policy gating, selected evidence, version preview, server-checked approved export, manual application progress, Lever approval, deletion and mobile layout without page errors. Isolated PostgreSQL verified repeatable migrations, owner isolation, changed/closed listing gates, URL-change deduplication, stale source approval denial, pinned observation adoption, context/policy invalidation, multiline restrictions and stale-evidence export denial. These are local test results; real discovery and production deployment must be verified separately in Actions and the deployed dashboard.
