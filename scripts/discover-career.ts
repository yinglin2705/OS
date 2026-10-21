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
      !["greenhouse", "lever"].includes(source.provider) ||
      !Array.isArray(source.keywords) ||
      source.keywords.length < 1 ||
      source.keywords.length > 20
    )
      throw Error("Invalid approved source");
    const result = await discoverBoard(source);
    state = result.state;
    detail = result.detail;
    seen = result.jobs.length;
    if (result.state === "success") {
      const written = await query(
        `select public.career_ingest_discovery(${sqlLiteral(source.id)}::uuid,${sqlLiteral(source.approved_at)}::timestamptz,${sqlLiteral(JSON.stringify(result.jobs))}::jsonb,${sqlLiteral(JSON.stringify(result.observed_ids))}::jsonb,${result.complete}) as added;`,
      );
      added = Number(written[0]?.added || 0);
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
