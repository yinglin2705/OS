\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000061'),('00000000-0000-4000-8000-000000000062');
insert into public.career_claims(id,user_id,kind,statement,keywords,source_text,verification) values
('50000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000061','skill','C4D class exercise',array['C4D'],'C4D evidence fixture','user_verified'),
('50000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000062','skill','Private fixture',array['C4D'],'Private evidence','user_verified');
insert into public.career_opportunities(id,user_id,title,employer,source_url,raw_jd) values('60000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000061','Studio assistant','Fixture studio','https://example.org/jobs/fixture','Essential requirements: C4D experience required.');
insert into public.career_sources(id,user_id,label,board_token,terms_url,terms_note,enabled) values('70000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000061','Fixture studio','fixture-studio','https://example.org/terms','Read-only fixture terms reviewed.',true);
update public.career_opportunities set source_id='70000000-0000-4000-8000-000000000061' where id='60000000-0000-4000-8000-000000000061';
insert into public.career_discovery_runs(user_id,source_id,state,detail,started_at) values('00000000-0000-4000-8000-000000000061','70000000-0000-4000-8000-000000000061','success','Fixture only',now());
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000061',true);
do $$ begin
 if (select count(*) from public.career_claims)<>1 then raise exception 'Profile RLS leaked';end if;
 if (select verified_at from public.career_claims limit 1) is null then raise exception 'Verification not stamped';end if;
 begin perform public.career_create_draft('60000000-0000-4000-8000-000000000061','cv',array['50000000-0000-4000-8000-000000000061'::uuid]);raise exception 'Unknown policy bypassed';exception when raise_exception then if SQLERRM='Unknown policy bypassed' then raise;end if;end;
end $$;
update public.career_opportunities set policy_decision='allowed',policy_url='https://example.org/policy',policy_quote='We explicitly allow AI assistance; check facts before applying.' where id='60000000-0000-4000-8000-000000000061';
select public.career_create_draft('60000000-0000-4000-8000-000000000061','cv',array['50000000-0000-4000-8000-000000000061'::uuid]);
do $$ begin
 if (select count(*) from public.career_documents)<>1 then raise exception 'Draft missing';end if;
 if not exists(select 1 from public.career_documents where body like '%C4D class exercise%' and jsonb_array_length(evidence_snapshot)=1) then raise exception 'Draft source missing';end if;
 begin perform public.career_create_draft('60000000-0000-4000-8000-000000000061','cv',array['50000000-0000-4000-8000-000000000062'::uuid]);raise exception 'Foreign evidence used';exception when raise_exception then if SQLERRM='Foreign evidence used' then raise;end if;end;
end $$;
delete from public.career_documents;
select public.career_create_draft('60000000-0000-4000-8000-000000000061','cv',array['50000000-0000-4000-8000-000000000061'::uuid]);
do $$ begin if (select version from public.career_documents)<>2 then raise exception 'Deleted version number reused';end if;end $$;
update public.career_opportunities set status='shortlisted';
do $$ begin
 if (select count(*) from public.career_application_history)<>2 then raise exception 'Application history missing';end if;
 if (select status from public.career_opportunities)<>'shortlisted' then raise exception 'Status changed automatically';end if;
end $$;
update public.career_opportunities set policy_quote='Do not use AI when applying to this employer.';
do $$ begin
 begin perform public.career_create_draft('60000000-0000-4000-8000-000000000061','cover_letter',array['50000000-0000-4000-8000-000000000061'::uuid]);raise exception 'Restrictive policy bypassed';exception when raise_exception then if SQLERRM='Restrictive policy bypassed' then raise;end if;end;
end $$;
update public.career_opportunities set raw_jd='New JD: essential C4D skill and lighting experience.';
do $$ begin if (select policy_decision from public.career_opportunities)<>'unknown' or (select policy_reviewed_at from public.career_opportunities) is not null then raise exception 'JD change retained policy approval';end if;end $$;
update public.career_opportunities set raw_jd='C4D role. Do not use AI in applications.';
update public.career_opportunities set policy_decision='allowed',policy_url='https://example.org/policy',policy_quote='AI assistance is allowed under the general company policy.';
do $$ begin
 begin perform public.career_create_draft('60000000-0000-4000-8000-000000000061','cv',array['50000000-0000-4000-8000-000000000061'::uuid]);raise exception 'Restrictive JD bypassed';exception when raise_exception then if SQLERRM='Restrictive JD bypassed' then raise;end if;end;
end $$;
delete from public.career_sources;
do $$ begin if not exists(select 1 from public.career_opportunities where source_id is null) then raise exception 'Source deletion lost opportunity';end if;end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000062',true);
do $$ begin
 if exists(select 1 from public.career_sources) or exists(select 1 from public.career_discovery_runs) or exists(select 1 from public.career_opportunities) or exists(select 1 from public.career_documents) then raise exception 'Foreign career data leaked';end if;
 begin perform public.career_create_draft('60000000-0000-4000-8000-000000000061','cv',array['50000000-0000-4000-8000-000000000062'::uuid]);raise exception 'Foreign job used';exception when raise_exception then if SQLERRM='Foreign job used' then raise;end if;end;
end $$;
reset role;
do $$ begin
 if has_table_privilege('authenticated','public.career_documents','INSERT') then raise exception 'Direct draft insert bypass';end if;
 if has_function_privilege('anon','public.career_create_draft(uuid,text,uuid[])','EXECUTE') then raise exception 'Anonymous drafting';end if;
end $$;
delete from auth.users where id='00000000-0000-4000-8000-000000000061';
do $$ begin if exists(select 1 from public.career_documents) or exists(select 1 from public.career_opportunities) or exists(select 1 from public.career_application_history) then raise exception 'Account cleanup incomplete';end if;end $$;
rollback;
