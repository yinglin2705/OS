begin;
select pg_advisory_xact_lock(hashtext('ying-os-career-agent-v1'));
create table if not exists public.career_claims (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references public.users on delete cascade,
 kind text not null check(kind in ('skill','experience','education','availability','eligibility')),
 statement text not null check(length(statement) between 1 and 4000),keywords text[] not null default '{}' check(cardinality(keywords)<=30),
 source_url text check(source_url is null or source_url ~ '^https?://'),source_text text not null check(length(source_text) between 1 and 12000),
 verification text not null default 'unverified' check(verification in ('unverified','user_verified','rejected')),verified_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id)
);
create table if not exists public.career_sources (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references public.users on delete cascade,
 label text not null check(length(label) between 1 and 200),provider text not null default 'greenhouse' check(provider='greenhouse'),
 board_token text not null check(board_token ~ '^[a-zA-Z0-9_-]{1,80}$'),keywords text[] not null default array['design','creative','art','production','studio','museum','theatre'],
 enabled boolean not null default false,terms_url text not null check(terms_url ~ '^https://'),terms_note text not null check(length(terms_note) between 10 and 4000),
 approved_at timestamptz,created_at timestamptz not null default now(),unique(user_id,provider,board_token),unique(id,user_id)
);
create table if not exists public.career_opportunities (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references public.users on delete cascade,
 source_id uuid,external_id text,title text not null check(length(title) between 1 and 200),employer text not null check(length(employer) between 1 and 200),location text not null default '',
 source_url text not null check(source_url ~ '^https?://'),raw_jd text not null check(length(raw_jd) between 20 and 80000),analysis jsonb not null default '{}',
 origin text not null default 'manual' check(origin in ('manual','greenhouse')),last_seen_at timestamptz,availability text not null default 'unknown' check(availability in ('unknown','listed','closed')),
 status text not null default 'saved' check(status in ('saved','shortlisted','drafting','ready','applied','interview','offer','rejected','withdrawn','archived')),
 application_notes text not null default '',document_counter integer not null default 0,policy_decision text not null default 'unknown' check(policy_decision in ('unknown','allowed','analysis_only','prohibited')),
 policy_url text check(policy_url is null or policy_url ~ '^https?://'),policy_quote text,policy_reviewed_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id),unique(user_id,source_url),
 foreign key(source_id,user_id) references public.career_sources(id,user_id) on delete set null(source_id)
);
create table if not exists public.career_documents (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid(),opportunity_id uuid not null,
 kind text not null check(kind in ('cv','cover_letter','personal_statement')),version integer not null,body text not null,
 evidence_snapshot jsonb not null,policy_snapshot jsonb not null,analysis_snapshot jsonb not null,engine text not null default 'evidence-template-v1',
 created_at timestamptz not null default now(),foreign key(opportunity_id,user_id) references public.career_opportunities(id,user_id) on delete cascade,
 unique(opportunity_id,kind,version)
);
create table if not exists public.career_application_history (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,opportunity_id uuid not null,old_status text,new_status text not null,
 created_at timestamptz not null default now(),foreign key(opportunity_id,user_id) references public.career_opportunities(id,user_id) on delete cascade
);
create table if not exists public.career_discovery_runs (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.users on delete cascade,source_id uuid,
 state text not null check(state in ('success','skipped','failed')),seen integer not null default 0,added integer not null default 0,
 detail text not null,started_at timestamptz not null,finished_at timestamptz not null default now(),
 foreign key(source_id,user_id) references public.career_sources(id,user_id) on delete set null(source_id)
);
create index if not exists career_jobs_owner_status on public.career_opportunities(user_id,status,updated_at desc);
create index if not exists career_runs_owner on public.career_discovery_runs(user_id,finished_at desc);
do $$ declare t text;begin foreach t in array array['career_claims','career_sources','career_opportunities','career_documents','career_application_history','career_discovery_runs'] loop
 execute format('alter table public.%I enable row level security',t);
 if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='career_owner') then execute format('create policy career_owner on public.%I for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid())',t);end if;
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,delete on public.%I to authenticated',t);
 end loop;end $$;
grant insert(kind,statement,keywords,source_url,source_text,verification),update(kind,statement,keywords,source_url,source_text,verification) on public.career_claims to authenticated;
grant insert(label,provider,board_token,keywords,enabled,terms_url,terms_note),update(label,board_token,keywords,enabled,terms_url,terms_note) on public.career_sources to authenticated;
grant insert(title,employer,location,source_url,raw_jd,analysis),update(title,employer,location,source_url,raw_jd,analysis,status,application_notes,policy_decision,policy_url,policy_quote) on public.career_opportunities to authenticated;
create or replace function public.career_stamp_claim() returns trigger language plpgsql set search_path=public as $$ begin
 new.updated_at=now();new.verified_at=case when new.verification='user_verified' then now() else null end;return new;end $$;
drop trigger if exists career_claim_stamp on public.career_claims;
create trigger career_claim_stamp before insert or update on public.career_claims for each row execute function public.career_stamp_claim();
create or replace function public.career_stamp_source() returns trigger language plpgsql set search_path=public as $$ begin
 if new.enabled and (length(btrim(new.terms_note))<10 or new.terms_url is null) then raise exception 'Review source terms before enabling discovery';end if;
 new.approved_at=case when new.enabled then now() else null end;return new;end $$;
drop trigger if exists career_source_stamp on public.career_sources;
create trigger career_source_stamp before insert or update on public.career_sources for each row execute function public.career_stamp_source();
create or replace function public.career_stamp_job() returns trigger language plpgsql set search_path=public as $$ begin
 new.updated_at=now();
 if TG_OP='UPDATE' and new.raw_jd is distinct from old.raw_jd then
 new.policy_decision='unknown';new.policy_quote=null;new.policy_url=null;new.policy_reviewed_at=null;
 elsif TG_OP='UPDATE' and new.policy_decision is not distinct from old.policy_decision and new.policy_quote is not distinct from old.policy_quote and new.policy_url is not distinct from old.policy_url then new.policy_reviewed_at=old.policy_reviewed_at;
 elsif new.policy_decision<>'unknown' then
 if new.policy_url is null or length(btrim(coalesce(new.policy_quote,'')))<10 then raise exception 'Policy evidence is required';end if;
 new.policy_reviewed_at=now();else new.policy_reviewed_at=null;end if;return new;end $$;
drop trigger if exists career_job_stamp on public.career_opportunities;
create trigger career_job_stamp before insert or update on public.career_opportunities for each row execute function public.career_stamp_job();
create or replace function public.career_audit_status() returns trigger language plpgsql security definer set search_path=public as $$ begin
 if TG_OP='INSERT' then insert into public.career_application_history(user_id,opportunity_id,new_status) values(new.user_id,new.id,new.status);
 elsif old.status is distinct from new.status then insert into public.career_application_history(user_id,opportunity_id,old_status,new_status) values(new.user_id,new.id,old.status,new.status);end if;return new;end $$;
drop trigger if exists career_status_audit on public.career_opportunities;
create trigger career_status_audit after insert or update on public.career_opportunities for each row execute function public.career_audit_status();
-- Server and direct authenticated callers share the same policy/evidence gate.
create or replace function public.career_create_draft(target uuid,document_kind text,claim_ids uuid[]) returns uuid
language plpgsql security definer set search_path=public as $$
declare j public.career_opportunities;facts text;snapshot jsonb;n integer;v integer;result uuid;heading text;begin
 select * into j from public.career_opportunities where id=target and user_id=auth.uid() for update;
 if not found then raise exception 'Opportunity unavailable';end if;
 if document_kind not in ('cv','cover_letter','personal_statement') then raise exception 'Unsupported document kind';end if;
 if j.policy_decision<>'allowed' or j.policy_reviewed_at is null or j.policy_url is null or length(coalesce(j.policy_quote,''))<10 then raise exception 'Employer AI policy does not permit drafting';end if;
 if concat_ws(E'\n',j.policy_quote,j.raw_jd) ~* '(do not|must not|not allowed|prohibit|ban(ned)?|no use of|without|不得|禁止|不允许).{0,100}(AI|artificial intelligence|生成式)|(AI|artificial intelligence).{0,80}(prohibit|not permitted|not allowed|must not|禁止)' then raise exception 'Restrictive policy signal requires human review';end if;
 if cardinality(claim_ids) is null or cardinality(claim_ids) not between 1 and 50 then raise exception 'Choose 1–50 verified evidence records';end if;
 select count(*),jsonb_agg(to_jsonb(c) order by c.created_at,c.id),string_agg('- '||c.statement||' [evidence '||c.id||']',E'\n' order by c.created_at,c.id)
 into n,snapshot,facts from public.career_claims c where c.id=any(claim_ids) and c.user_id=auth.uid() and c.verification='user_verified' and c.verified_at is not null;
 if n<>(select count(distinct x) from unnest(claim_ids)x) then raise exception 'Evidence missing, unverified or not owned';end if;
 update public.career_opportunities set document_counter=document_counter+1 where id=target returning document_counter into v;
 heading=case document_kind when 'cv' then 'CV evidence draft' when 'cover_letter' then 'Cover letter evidence draft' else 'Personal statement evidence draft' end;
 insert into public.career_documents(user_id,opportunity_id,kind,version,body,evidence_snapshot,policy_snapshot,analysis_snapshot)
 values(auth.uid(),target,document_kind,v,'# '||heading||E'\n\n'||j.title||' · '||j.employer||E'\n\n'||facts||E'\n\n[本人审阅后补充动机、联系信息及要求对应关系；这是证据草稿，不是最终申请材料。]',snapshot,jsonb_build_object('decision',j.policy_decision,'quote',j.policy_quote,'source_url',j.policy_url,'reviewed_at',j.policy_reviewed_at),jsonb_build_object('analysis',j.analysis,'source_url',j.source_url,'title',j.title,'employer',j.employer,'raw_jd',j.raw_jd)) returning id into result;return result;
end $$;
revoke all on function public.career_create_draft(uuid,text,uuid[]) from public,anon;
grant execute on function public.career_create_draft(uuid,text,uuid[]) to authenticated;
commit;
