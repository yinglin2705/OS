\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000081'),('00000000-0000-4000-8000-000000000082');
insert into public.events(id,user_id,title,status,start_at,end_at) values('20000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000081','Robotics fixture','planned','2026-10-19T13:00:00Z','2026-10-19T13:30:00Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000081',true);
select public.set_event_status('20000000-0000-4000-8000-000000000081',1,'booked');
do $$ begin
 if not exists(select 1 from public.events where status='booked' and version=2 and start_at='2026-10-19T13:00:00Z') then raise exception 'Status or dates incorrect';end if;
 if not exists(select 1 from public.event_sources where source_type='manual_status' and original_record->>'old_status'='planned') then raise exception 'Status provenance missing';end if;
 if (select count(*) from public.event_status_history)<>2 then raise exception 'Status history missing';end if;
 begin perform public.set_event_status('20000000-0000-4000-8000-000000000081',1,'cancelled');raise exception 'Stale version accepted';exception when raise_exception then if SQLERRM='Stale version accepted' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000082',true);
do $$ begin
 begin perform public.set_event_status('20000000-0000-4000-8000-000000000081',2,'cancelled');raise exception 'Foreign status changed';exception when raise_exception then if SQLERRM='Foreign status changed' then raise;end if;end;
end $$;
reset role;
do $$ begin if has_function_privilege('anon','public.set_event_status(uuid,integer,text)','EXECUTE') then raise exception 'Anonymous status access';end if;end $$;
rollback;
