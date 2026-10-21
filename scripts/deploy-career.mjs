import { readFile } from "node:fs/promises";
const ref = process.env.SUPABASE_PROJECT_REF || "flhwcojxhsyjpzfqxttx",
  token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token || !/^[a-z]{20}$/.test(ref))
  throw Error("Missing protected Supabase access configuration.");
async function query(sql) {
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
      `Career migration request failed (HTTP ${r.status}); no response body logged.`,
    );
  return r.json();
}
try {
  // Apply both revisions atomically; replay must never temporarily restore the older policy gate.
  const migrations = await Promise.all(["007_career_agent", "010_career_hardening"].map(name =>
    readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8")));
  await query("begin;\n" + migrations.map(sql => sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, "")).join("\n") + "\ncommit;");
  const result = await query(
    "select count(*) as private_tables from pg_tables where schemaname='public' and tablename in ('career_claims','career_sources','career_opportunities','career_documents','career_application_history','career_discovery_runs','career_match_runs','career_job_observations') and rowsecurity;",
  );
  if (Number(result?.[0]?.private_tables) !== 8)
    throw Error("Career RLS verification failed.");
  const gates = await query(
    "select has_function_privilege('authenticated','public.career_create_draft(uuid,text,uuid[])','EXECUTE') as owner_gate,has_function_privilege('anon','public.career_create_draft(uuid,text,uuid[])','EXECUTE') as anon_gate,has_table_privilege('authenticated','public.career_documents','INSERT') as direct_drafts,has_function_privilege('authenticated','public.career_export_document(uuid)','EXECUTE') as owner_export,has_function_privilege('anon','public.career_export_document(uuid)','EXECUTE') as anon_export,has_function_privilege('authenticated','public.career_ingest_discovery(uuid,timestamptz,jsonb,jsonb,boolean)','EXECUTE') as client_ingest;",
  );
  if (!gates[0]?.owner_gate || gates[0]?.anon_gate || gates[0]?.direct_drafts || !gates[0]?.owner_export || gates[0]?.anon_export || gates[0]?.client_ingest)
    throw Error("Career draft authorization verification failed.");
  console.log(
    "::notice title=Career schema::Eight private career tables and database policy gate verified. Existing OS tables, notifications and Cron untouched.",
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Career deployment failed");
  process.exitCode = 1;
}
