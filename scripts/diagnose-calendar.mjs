// Read-only production diagnosis: aggregate counts only, no titles, dates,
// account identifiers, source contents, credentials or persistent writes.
const ref=process.env.SUPABASE_PROJECT_REF||'flhwcojxhsyjpzfqxttx',token=process.env.SUPABASE_ACCESS_TOKEN;
if(!token||!/^[a-z]{20}$/.test(ref))throw Error('Missing protected Supabase access configuration.');
async function query(query){const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error(`Calendar diagnosis failed (HTTP ${r.status}); response not logged.`);return r.json();}
try {
 const accounts=await query('select count(*)::int as accounts from public.users;');
 if(accounts?.[0]?.accounts!==1)throw Error('Diagnosis requires the authenticated owner: multiple accounts, no private records queried.');
 const result=await query(`begin;
 select set_config('request.jwt.claim.sub',(select id::text from public.users limit 1),true);
 set local role authenticated;
 select set_config('ying.calendar.metrics',jsonb_build_object(
 'active_records',(select count(*) from public.events where deleted_at is null),
 'with_start',(select count(*) from public.events where deleted_at is null and start_at is not null),
 'without_start',(select count(*) from public.events where deleted_at is null and start_at is null),
 'deadline_only',(select count(*) from public.events where deleted_at is null and start_at is null and deadline_at is not null),
 'confirmed',(select count(*) from public.events where deleted_at is null and status='confirmed'),
 'starts_this_week',(select count(*) from public.events where deleted_at is null and date_trunc('week',start_at at time zone 'Europe/London')=date_trunc('week',now() at time zone 'Europe/London')),
 'starts_today',(select count(*) from public.events where deleted_at is null and (start_at at time zone 'Europe/London')::date=(now() at time zone 'Europe/London')::date),
 'trash',(select count(*) from public.events where deleted_at is not null),
 'pending_legacy',(select count(*) from public.change_proposals where state='pending'),
 'source_records',(select count(*) from public.event_sources)
 )::text,false);
 commit;
 select current_setting('ying.calendar.metrics')::jsonb as metrics;`);
 const metrics=result?.find(r=>r?.metrics)?.metrics;
 if(!metrics||Object.values(metrics).some(v=>typeof v!=='number'))throw Error('Aggregate diagnostic result not verified.');
 console.log('::notice title=Read-only calendar counts::'+JSON.stringify(metrics));
}catch(e){console.error(e instanceof Error?e.message:'Diagnosis failed');process.exitCode=1;}
