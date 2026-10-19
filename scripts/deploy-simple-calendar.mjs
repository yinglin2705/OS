import { readFile } from "node:fs/promises";
const ref = process.env.SUPABASE_PROJECT_REF || "flhwcojxhsyjpzfqxttx",
  token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token || !/^[a-z]{20}$/.test(ref))
  throw Error("Missing protected Supabase access configuration.");
async function query(query) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!r.ok)
    throw Error(
      `Calendar deployment failed (HTTP ${r.status}); response not logged.`,
    );
  return r.json();
}
try {
  await query(
    await readFile(
      new URL(
        "../supabase/migrations/009_simple_calendar.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const gates = await query(
    "select has_function_privilege('authenticated','public.ingest_calendar_records(jsonb,text,text)','EXECUTE') as owner_gate,has_function_privilege('anon','public.ingest_calendar_records(jsonb,text,text)','EXECUTE') as anon_gate;",
  );
  if (!gates[0]?.owner_gate || gates[0]?.anon_gate)
    throw Error("Direct import authorization verification failed.");
  console.log(
    "::notice title=Simple calendar::Direct imports and four-status controls deployed; owner-only permissions verified.",
  );
  // Explicit user authorization on 2026-10-19. Receipt prevents future deployments
  // from overriding statuses the user changes after this one-time operation.
  await query(`begin;
 select pg_advisory_xact_lock(hashtext('confirm-existing-calendar-20261019'));
 do $$ declare owner_id uuid;n integer;begin
 if exists(select 1 from public.calendar_operation_receipts where operation='confirm_existing_20261019') then return;end if;
 if (select count(*) from public.users)<>1 then return;end if;
 select id into owner_id from public.users;
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 n=public.confirm_all_calendar_events();
 insert into public.calendar_operation_receipts(operation,user_id,changed) values('confirm_existing_20261019',owner_id,n);
 end $$;
 commit;`);
  const result = await query(
    "select case when exists(select 1 from public.calendar_operation_receipts where operation='confirm_existing_20261019') then 'completed_snapshot' when (select count(*) from public.users)<>1 then 'blocked_multiple_accounts' else 'unverified' end as state,coalesce((select changed from public.calendar_operation_receipts where operation='confirm_existing_20261019'),0) as changed;",
  );
  const summary = Array.isArray(result)
    ? result.find((row) => row?.state)
    : null;
  if (!summary || summary.state === "unverified")
    throw Error("One-time confirmation result could not be verified.");
  if (summary.state === "blocked_multiple_accounts")
    console.log(
      "::warning title=Calendar confirmation blocked::Multiple accounts exist; no calendar data changed. Use authenticated calendar bulk confirmation instead.",
    );
  else
    console.log(
      `::notice title=Existing calendar confirmation::${summary.state}; ${Number(summary.changed)} event status changes. Original sources and audit history retained; trash excluded.`,
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Calendar deployment failed");
  process.exitCode = 1;
}
