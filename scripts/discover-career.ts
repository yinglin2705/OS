import { discoverBoard, sqlLiteral } from "../lib/career/discovery.ts";
const ref = process.env.SUPABASE_PROJECT_REF || "flhwcojxhsyjpzfqxttx";
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token || !/^[a-z]{20}$/.test(ref))
  throw Error("Protected Supabase access configuration is missing or invalid.");
async function query(sql: string) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!r.ok)
    throw Error(
      `Database management request failed (HTTP ${r.status}); response not logged.`,
    );
  return r.json();
}
const sources = await query(
  `select s.* from public.career_sources s where enabled and approved_at is not null order by (select max(finished_at) from public.career_discovery_runs r where r.source_id=s.id) asc nulls first,s.created_at limit 6;`,
);
let count = 0,
  failures = 0;
for (const source of sources) {
  const started = new Date().toISOString();
  let state = "failed",
    detail = "Discovery failed; no immediate retry.",
    seen = 0,
    added = 0;
  try {
    // Bound even database configuration: only explicit approved sources get requests.
    if (
      !source.enabled ||
      !source.approved_at ||
      source.provider !== "greenhouse" ||
      !Array.isArray(source.keywords) ||
      source.keywords.length < 1 ||
      source.keywords.length > 20
    )
      throw Error("Invalid approved source");
    const result = await discoverBoard(source);
    state = result.state;
    detail = result.detail;
    seen = result.jobs.length;
    if (result.jobs.length) {
      // Guard authorization again at write time: disabling/deleting the source while
      // discovery runs prevents new inserts. Discovery never overwrites JD, policy,
      // drafts, notes or manually updated application progress.
      const rows = result.jobs
        .map(
          (j) =>
            `(${sqlLiteral(source.user_id)}::uuid,${sqlLiteral(source.id)}::uuid,${sqlLiteral(j.external_id)},${sqlLiteral(j.title)},${sqlLiteral(j.employer)},${sqlLiteral(j.location)},${sqlLiteral(j.source_url)},${sqlLiteral(j.raw_jd)},${sqlLiteral(JSON.stringify(j.analysis))}::jsonb)`,
        )
        .join(",");
      const written = await query(
        `with candidates(user_id,source_id,external_id,title,employer,location,source_url,raw_jd,analysis) as (values ${rows}), inserted as (insert into public.career_opportunities(user_id,source_id,external_id,title,employer,location,source_url,raw_jd,analysis,origin,last_seen_at,availability) select c.*,'greenhouse',now(),'listed' from candidates c join public.career_sources s on s.id=c.source_id and s.user_id=c.user_id where s.enabled and s.approved_at is not null on conflict(user_id,source_url) do nothing returning id) select count(*) as added from inserted;`,
      );
      added = Number(written[0]?.added || 0);
      const urls = result.jobs.map((j) => sqlLiteral(j.source_url)).join(",");
      await query(
        `update public.career_opportunities j set last_seen_at=now(),availability='listed' where j.user_id=${sqlLiteral(source.user_id)}::uuid and j.source_id=${sqlLiteral(source.id)}::uuid and j.source_url in (${urls}) and exists(select 1 from public.career_sources s where s.id=j.source_id and s.enabled and s.approved_at is not null);`,
      );
    }
  } catch {
    state = "failed";
    detail =
      "Discovery or persistence failed; saved records retained. No immediate retry.";
    failures++;
  }
  await query(
    `insert into public.career_discovery_runs(user_id,source_id,state,seen,added,detail,started_at) select user_id,id,${sqlLiteral(state)},${seen},${added},${sqlLiteral(detail)},${sqlLiteral(started)}::timestamptz from public.career_sources where id=${sqlLiteral(source.id)}::uuid;`,
  );
  count++;
  if (count < sources.length) await new Promise((r) => setTimeout(r, 1100));
}
console.log(
  `Career discovery finished: ${count} approved source(s), ${failures} failure(s). Details are private in the dashboard. No applications or emails sent.`,
);
if (failures) process.exitCode = 1;
