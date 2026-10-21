begin;
select pg_advisory_xact_lock(hashtext('ying-os-career-agent-v1'));
alter table public.career_sources drop constraint if exists career_sources_provider_check;
alter table public.career_sources add constraint career_sources_provider_check check(provider in ('greenhouse','lever'));
alter table public.career_opportunities drop constraint if exists career_opportunities_origin_check;
alter table public.career_opportunities add constraint career_opportunities_origin_check check(origin in ('manual','greenhouse','lever'));
alter table public.career_opportunities add column if not exists source_changed_at timestamptz;
create table if not exists public.career_job_observations (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, opportunity_id uuid not null,
 source_url text not null, raw_jd text not null, title text not null, employer text not null, analysis jsonb not null,
 fingerprint text not null, observed_at timestamptz not null default now(),
 foreign key(opportunity_id,user_id) references public.career_opportunities(id,user_id) on delete cascade,
 unique(opportunity_id,fingerprint)
);
create table if not exists public.career_match_runs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), opportunity_id uuid not null,
 analysis jsonb not null, result jsonb not null, profile_snapshot jsonb not null, job_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(opportunity_id,user_id) references public.career_opportunities(id,user_id) on delete cascade
);
do $$ declare t text; begin foreach t in array array['career_job_observations','career_match_runs'] loop
 execute format('alter table public.%I enable row level security',t);
 if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='career_owner') then
 execute format('create policy career_owner on public.%I for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid())',t);end if;
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,delete on public.%I to authenticated',t);
 end loop;end $$;
grant insert(opportunity_id,analysis,result,profile_snapshot,job_snapshot) on public.career_match_runs to authenticated;
create index if not exists career_matches_owner on public.career_match_runs(user_id,opportunity_id,created_at desc);
create index if not exists career_observations_owner on public.career_job_observations(user_id,opportunity_id,observed_at desc);
create index if not exists career_external_identity on public.career_opportunities(source_id,external_id);
-- Source lock serializes feed writes; approval timestamp also prevents stale authorization.
create or replace function public.career_ingest_discovery(target uuid, approval timestamptz, jobs jsonb, observed_ids jsonb, complete boolean)
returns integer language plpgsql security definer set search_path=public as $$
declare s public.career_sources; j public.career_opportunities; item jsonb; added integer=0; fp text;begin
 select * into s from public.career_sources where id=target for update;
 if not found or not s.enabled or s.approved_at is null or s.approved_at is distinct from approval then raise exception 'Source approval changed';end if;
 if jsonb_typeof(jobs)<>'array' or jsonb_array_length(jobs)>100 or jsonb_typeof(observed_ids)<>'array' or jsonb_array_length(observed_ids)>5000 then raise exception 'Invalid discovery payload';end if;
 for item in select value from jsonb_array_elements(jobs) loop
 if length(coalesce(item->>'external_id','')) not between 1 and 200 or length(coalesce(item->>'raw_jd','')) not between 20 and 80000 or (item->>'source_url') !~ '^https://' then raise exception 'Invalid listing';end if;
 select * into j from public.career_opportunities where user_id=s.user_id and
 ((source_id=s.id and external_id=item->>'external_id') or source_url=item->>'source_url')
 order by (source_id=s.id and external_id=item->>'external_id') desc nulls last,created_at limit 1 for update;
 if not found then
 insert into public.career_opportunities(user_id,source_id,external_id,title,employer,location,source_url,raw_jd,analysis,origin,last_seen_at,availability)
 values(s.user_id,s.id,item->>'external_id',item->>'title',item->>'employer',coalesce(item->>'location',''),item->>'source_url',item->>'raw_jd',item->'analysis',s.provider,now(),'listed') returning * into j;
 added=added+1;
 else
 update public.career_opportunities set last_seen_at=now(),availability='listed',
 external_id=case when source_id is null then item->>'external_id' else external_id end,source_id=coalesce(source_id,s.id),
 source_changed_at=case when (raw_jd,title,employer,source_url) is distinct from (item->>'raw_jd',item->>'title',item->>'employer',item->>'source_url') then coalesce(source_changed_at,now()) else null end
 where id=j.id;
 end if;
 fp=md5(jsonb_build_array(item->>'raw_jd',item->>'title',item->>'employer',item->>'source_url')::text);
 insert into public.career_job_observations(user_id,opportunity_id,source_url,raw_jd,title,employer,analysis,fingerprint)
 values(s.user_id,j.id,item->>'source_url',item->>'raw_jd',item->>'title',item->>'employer',item->'analysis',fp)
 on conflict(opportunity_id,fingerprint) do update set observed_at=now();
 end loop;
 -- A capped candidate shortlist is NOT a complete feed. observed_ids comes from all provider records.
 if complete then
 update public.career_opportunities set availability='closed' where source_id=s.id and user_id=s.user_id and external_id is not null
 and not exists(select 1 from jsonb_array_elements_text(observed_ids) x where x=external_id);
 end if;
 return added;
end $$;
revoke all on function public.career_ingest_discovery(uuid,timestamptz,jsonb,jsonb,boolean) from public,anon,authenticated;
-- Management SQL runs as postgres; clients never receive discovery write authority.
create or replace function public.career_stamp_job() returns trigger language plpgsql set search_path=public as $$ begin
 new.updated_at=now();
 if TG_OP='UPDATE' and (new.raw_jd,new.title,new.employer,new.source_url) is distinct from (old.raw_jd,old.title,old.employer,old.source_url) then
 new.policy_decision='unknown';new.policy_quote=null;new.policy_url=null;new.policy_reviewed_at=null;
 elsif TG_OP='UPDATE' and new.policy_decision is not distinct from old.policy_decision and new.policy_quote is not distinct from old.policy_quote and new.policy_url is not distinct from old.policy_url then new.policy_reviewed_at=old.policy_reviewed_at;
 elsif new.policy_decision<>'unknown' then
 if new.policy_url is null or length(btrim(coalesce(new.policy_quote,'')))<10 then raise exception 'Policy evidence is required';end if;
 new.policy_reviewed_at=now();else new.policy_reviewed_at=null;end if;return new;end $$;
create or replace function public.career_adopt_observation(target uuid, observation uuid) returns void
language plpgsql security definer set search_path=public as $$
declare o public.career_job_observations;begin
 perform 1 from public.career_opportunities where id=target and user_id=auth.uid() for update;
 if not found then raise exception 'Opportunity unavailable';end if;
 select * into o from public.career_job_observations where opportunity_id=target and user_id=auth.uid() and id=observation;
 if not found then raise exception 'Observation unavailable';end if;
 update public.career_opportunities set raw_jd=o.raw_jd,title=o.title,employer=o.employer,source_url=o.source_url,analysis=o.analysis,source_changed_at=case when exists(select 1 from public.career_job_observations newer where newer.opportunity_id=target and newer.observed_at>o.observed_at and newer.fingerprint<>o.fingerprint) then now() else null end where id=target;
end $$;
revoke all on function public.career_adopt_observation(uuid,uuid) from public,anon;
grant execute on function public.career_adopt_observation(uuid,uuid) to authenticated;
-- One database gate for creation and export, including direct authenticated RPC calls.
create or replace function public.career_assert_draftable(target uuid) returns void
language plpgsql security definer set search_path=public as $$
declare j public.career_opportunities;begin
 select * into j from public.career_opportunities where id=target and user_id=auth.uid();
 if not found then raise exception 'Opportunity unavailable';end if;
 if j.availability='closed' or j.source_changed_at is not null then raise exception 'Listing closed or changed; review source first';end if;
 if j.policy_decision<>'allowed' or j.policy_reviewed_at is null or j.policy_url is null or length(coalesce(j.policy_quote,''))<10 then raise exception 'Employer AI policy does not permit drafting';end if;
 if regexp_replace(concat_ws(E'\n',j.policy_quote,j.raw_jd),'[[:space:]]+',' ','g') ~* '(do not|must not|not allowed|prohibit|ban(ned)?|no use of|without|不得|禁止|不允许).{0,100}(AI|artificial intelligence|生成式)|(AI|artificial intelligence).{0,80}(prohibit|not permitted|not allowed|must not|禁止)' then raise exception 'Restrictive policy signal requires human review';end if;
end $$;
revoke all on function public.career_assert_draftable(uuid) from public,anon,authenticated;
create or replace function public.career_create_draft(target uuid,document_kind text,claim_ids uuid[]) returns uuid
language plpgsql security definer set search_path=public as $$
declare j public.career_opportunities;facts text;snapshot jsonb;n integer;v integer;result uuid;heading text;begin
 select * into j from public.career_opportunities where id=target and user_id=auth.uid() for update;
 if not found then raise exception 'Opportunity unavailable';end if;
 if document_kind not in ('cv','cover_letter','personal_statement') then raise exception 'Unsupported document kind';end if;
 perform public.career_assert_draftable(target);
 if cardinality(claim_ids) is null or cardinality(claim_ids) not between 1 and 50 then raise exception 'Choose 1–50 verified evidence records';end if;
 select count(*),jsonb_agg(to_jsonb(c) order by c.created_at,c.id),string_agg('- '||c.statement||' [evidence '||c.id||']',E'\n' order by c.created_at,c.id)
 into n,snapshot,facts from public.career_claims c where c.id=any(claim_ids) and c.user_id=auth.uid() and c.verification='user_verified' and c.verified_at is not null;
 if n<>(select count(distinct x) from unnest(claim_ids)x) then raise exception 'Evidence missing, unverified or not owned';end if;
 update public.career_opportunities set document_counter=document_counter+1 where id=target returning document_counter into v;
 heading=case document_kind when 'cv' then 'CV evidence draft' when 'cover_letter' then 'Cover letter evidence draft' else 'Personal statement evidence draft' end;
 insert into public.career_documents(user_id,opportunity_id,kind,version,body,evidence_snapshot,policy_snapshot,analysis_snapshot)
 values(auth.uid(),target,document_kind,v,'# '||heading||E'\n\n'||j.title||' · '||j.employer||E'\n\n'||case document_kind when 'cv' then E'## Verified experience and qualifications\n' when 'cover_letter' then E'Dear hiring team,\n\nRe: '||j.title||E'\n[Add your own motivation here.]\n\nSelected evidence for this role:\n' else E'## Evidence supporting this application\n[Add your own narrative and relationship to the role here.]\n' end||facts||E'\n\n[本人审阅后补充动机、联系信息及要求对应关系；这是证据草稿，不是最终申请材料。]',snapshot,jsonb_build_object('decision',j.policy_decision,'quote',j.policy_quote,'source_url',j.policy_url,'reviewed_at',j.policy_reviewed_at),jsonb_build_object('analysis',j.analysis,'source_url',j.source_url,'title',j.title,'employer',j.employer,'raw_jd',j.raw_jd)) returning id into result;return result;
end $$;
revoke all on function public.career_create_draft(uuid,text,uuid[]) from public,anon;
grant execute on function public.career_create_draft(uuid,text,uuid[]) to authenticated;
create or replace function public.career_export_document(target uuid) returns text
language plpgsql security definer set search_path=public as $$
declare d public.career_documents;j public.career_opportunities;begin
 select * into d from public.career_documents where id=target and user_id=auth.uid();
 if not found then raise exception 'Document unavailable';end if;
 select * into j from public.career_opportunities where id=d.opportunity_id for update;
 perform public.career_assert_draftable(j.id);
 if (d.analysis_snapshot->>'raw_jd',d.analysis_snapshot->>'title',d.analysis_snapshot->>'employer',d.analysis_snapshot->>'source_url') is distinct from (j.raw_jd,j.title,j.employer,j.source_url) then raise exception 'Job context changed';end if;
 if exists(select 1 from jsonb_array_elements(d.evidence_snapshot) e where not exists(
 select 1 from public.career_claims c where c.id=(e->>'id')::uuid and c.user_id=auth.uid() and c.verification='user_verified' and c.verified_at is not null
 and (c.statement,c.source_text,c.source_url) is not distinct from (e->>'statement',e->>'source_text',e->>'source_url'))) then raise exception 'Evidence changed';end if;
 return d.body;
end $$;
revoke all on function public.career_export_document(uuid) from public,anon;
grant execute on function public.career_export_document(uuid) to authenticated;
commit;
