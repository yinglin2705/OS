\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000091'),('00000000-0000-4000-8000-000000000092');
insert into public.events(id,user_id,title,status,deleted_at) values
('20000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000091','Saved fixture','planned',null),
('20000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000092','Other owner','planned',null),
('20000000-0000-4000-8000-000000000093','00000000-0000-4000-8000-000000000091','Trashed fixture','cancelled',now());
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000091',true);
select public.confirm_all_calendar_events();
do $$ begin
 if not exists(select 1 from public.events where title='Saved fixture' and status='confirmed') then raise exception 'Bulk confirmation missing';end if;
 if not exists(select 1 from public.events where title='Trashed fixture' and status='cancelled') then raise exception 'Trash changed';end if;
 if not exists(select 1 from public.event_sources where source_type='manual_status') then raise exception 'Original status history lost';end if;
end $$;
select public.set_event_status('20000000-0000-4000-8000-000000000091',2,'conflict');
select public.ingest_calendar_records('[{"payload":{"title":"Direct import fixture","status":"planned","start_at":null},"source":{"source_type":"csv","notes":"fixture original"},"warnings":["Unknown time"]}]','csv','fixture.csv');
do $$ begin
 if not exists(select 1 from public.events where title='Direct import fixture' and status='planned' and start_at is null) then raise exception 'Direct import missing/unknown fabricated';end if;
 if exists(select 1 from public.change_proposals where state='pending') then raise exception 'Direct import left confirmation gate';end if;
 if not exists(select 1 from public.event_sources where notes='fixture original') then raise exception 'Direct import provenance lost';end if;
 begin perform public.ingest_calendar_records('[{"payload":{"title":"Must rollback"},"source":{}},{"payload":{"title":""},"source":{}}]','csv',null);raise exception 'Bad batch committed';exception when raise_exception then if SQLERRM='Bad batch committed' then raise;end if;when check_violation then null;end;
 if exists(select 1 from public.events where title='Must rollback') then raise exception 'Partial batch persisted';end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000092',true);
do $$ begin
 if not exists(select 1 from public.events where title='Other owner' and status='planned') then raise exception 'Foreign bulk modification';end if;
 begin perform public.ingest_calendar_records('[{"event_id":"20000000-0000-4000-8000-000000000091","expected_version":3,"payload":{"status":"cancelled"},"source":{}}]','manual',null);raise exception 'Foreign import succeeded';exception when raise_exception then if SQLERRM='Foreign import succeeded' then raise;end if;end;
end $$;
reset role;
do $$ begin if has_function_privilege('anon','public.ingest_calendar_records(jsonb,text,text)','EXECUTE') or has_function_privilege('anon','public.confirm_all_calendar_events()','EXECUTE') then raise exception 'Anonymous calendar write';end if;end $$;
rollback;
