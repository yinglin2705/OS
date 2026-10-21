\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000081'),('00000000-0000-4000-8000-000000000082');
insert into public.career_sources(id,user_id,label,provider,board_token,terms_url,terms_note,enabled)
values('70000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000081','Fixture','lever','fixture','https://example.org/terms','Explicit fixture approval only',true);
create temporary table payload as select '[{"external_id":"abc","title":"Design assistant","employer":"Fixture","location":"London","source_url":"https://example.org/old","raw_jd":"Essential: C4D skills required for design work.","analysis":{}}]'::jsonb as jobs;
select public.career_ingest_discovery(s.id,s.approved_at,p.jobs,'["abc"]',true) from public.career_sources s,payload p;
-- Stable ATS ID wins even when the URL and JD change. Manual progress is preserved.
update public.career_opportunities set status='shortlisted',application_notes='Keep my notes';
update payload set jobs=jsonb_set(jsonb_set(jobs,'{0,source_url}','"https://example.org/new"'),'{0,raw_jd}','"Essential: C4D and lighting skills required for design work."');
select public.career_ingest_discovery(s.id,s.approved_at,p.jobs,'["abc"]',true) from public.career_sources s,payload p;
do $$ begin
 if (select count(*) from public.career_opportunities)<>1 then raise exception 'Stable identity duplicated';end if;
 if not exists(select 1 from public.career_opportunities where source_changed_at is not null and status='shortlisted' and application_notes='Keep my notes' and source_url='https://example.org/old') then raise exception 'Source refresh overwrote saved data';end if;
 begin perform public.career_ingest_discovery('70000000-0000-4000-8000-000000000081','2000-01-01','[]','[]',true);raise exception 'Stale approval accepted';exception when raise_exception then if SQLERRM='Stale approval accepted' then raise;end if;end;
end $$;
select public.career_ingest_discovery(s.id,s.approved_at,'[]','[]',false) from public.career_sources s;
do $$ begin if exists(select 1 from public.career_opportunities where availability='closed') then raise exception 'Partial feed closed a role';end if;end $$;
insert into public.career_claims(id,user_id,kind,statement,keywords,source_text,verification) values('50000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000081','skill','C4D class exercise',array['C4D'],'C4D class record','user_verified');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000081',true);
update public.career_opportunities set policy_decision='allowed',policy_url='https://example.org/policy',policy_quote='AI assistance is allowed with human fact checking.';
do $$ begin
 begin perform public.career_create_draft(id,'cv',array['50000000-0000-4000-8000-000000000081'::uuid]) from public.career_opportunities;raise exception 'Changed source drafted';exception when raise_exception then if SQLERRM='Changed source drafted' then raise;end if;end;
end $$;
select public.career_adopt_observation(j.id,(select o.id from public.career_job_observations o where o.opportunity_id=j.id and o.source_url='https://example.org/new' limit 1)) from public.career_opportunities j;
update public.career_opportunities set policy_decision='allowed',policy_url='https://example.org/policy',policy_quote='AI assistance is allowed with human fact checking.';
select public.career_create_draft(id,'cover_letter',array['50000000-0000-4000-8000-000000000081'::uuid]) from public.career_opportunities;
select public.career_export_document(id) from public.career_documents;
update public.career_opportunities set title='Revised role title';
do $$ begin if exists(select 1 from public.career_opportunities where policy_reviewed_at is not null) then raise exception 'Changed employer context retained policy';end if;end $$;
update public.career_opportunities set title='Design assistant';
update public.career_opportunities set policy_decision='allowed',policy_url='https://example.org/policy',policy_quote=E'Do not use\nAI to prepare this application.';
do $$ begin
 begin perform public.career_export_document(id) from public.career_documents;raise exception 'Multiline restrictive policy exported';exception when raise_exception then if SQLERRM='Multiline restrictive policy exported' then raise;end if;end;
end $$;
update public.career_opportunities set policy_quote='AI assistance is allowed with human fact checking.';
update public.career_claims set statement='Updated C4D class record';
do $$ begin
 begin perform public.career_export_document(id) from public.career_documents;raise exception 'Stale evidence exported';exception when raise_exception then if SQLERRM='Stale evidence exported' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000082',true);
do $$ begin
 if exists(select 1 from public.career_job_observations) or exists(select 1 from public.career_match_runs) then raise exception 'Snapshot privacy leak';end if;
end $$;
reset role;
select public.career_ingest_discovery(s.id,s.approved_at,'[]','[]',true) from public.career_sources s;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000081',true);
do $$ begin
 begin perform public.career_create_draft(id,'cv',array['50000000-0000-4000-8000-000000000081'::uuid]) from public.career_opportunities;raise exception 'Closed role drafted';exception when raise_exception then if SQLERRM='Closed role drafted' then raise;end if;end;
end $$;
reset role;
do $$ begin
 if has_function_privilege('authenticated','public.career_ingest_discovery(uuid,timestamptz,jsonb,jsonb,boolean)','EXECUTE') then raise exception 'Discovery client privilege';end if;
 if has_function_privilege('anon','public.career_export_document(uuid)','EXECUTE') then raise exception 'Anonymous export';end if;
end $$;
rollback;
