begin;
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check check(status in ('confirmed','conflict','booked','applied','planned','considering','waiting','cancelled','completed'));
create or replace function public.set_event_status(target uuid,expected_version integer,new_status text) returns uuid
language plpgsql security definer set search_path=public as $$
declare e public.events;begin
 if auth.uid() is null then raise exception 'Authentication required';end if;
 if new_status is null or new_status not in ('confirmed','conflict','booked','applied','planned','considering','waiting','cancelled','completed') then raise exception 'Invalid status';end if;
 select * into e from public.events where id=target and user_id=auth.uid() and deleted_at is null for update;
 if not found or e.version is distinct from expected_version then raise exception 'Event changed or unavailable';end if;
 if e.status=new_status then return e.id;end if;
 update public.events set status=new_status where id=e.id;
 insert into public.event_sources(user_id,event_id,source_type,notes,original_record) values(auth.uid(),e.id,'manual_status','用户在活动详情直接修改状态',jsonb_build_object('old_status',e.status,'new_status',new_status));
 return e.id;
end $$;
revoke all on function public.set_event_status(uuid,integer,text) from public,anon;
grant execute on function public.set_event_status(uuid,integer,text) to authenticated;

-- Non-content idempotency receipt, retained until account deletion so cleaning
-- ordinary import history cannot accidentally re-run a one-time status reset.
create table if not exists public.calendar_operation_receipts (
 operation text primary key,user_id uuid not null references public.users on delete cascade,
 changed integer not null check(changed>=0),completed_at timestamptz not null default now()
);
alter table public.calendar_operation_receipts enable row level security;
revoke all on public.calendar_operation_receipts from public,anon,authenticated;
-- An authenticated import is an explicit write. The whole batch commits or none
-- of it does; provenance still goes through the existing audited confirmation RPC.
create or replace function public.ingest_calendar_records(records jsonb,batch_source_type text,batch_filename text default null) returns uuid[]
language plpgsql security definer set search_path=public as $$
declare batch uuid;record jsonb;proposal uuid;event_id uuid;result uuid[]:='{}';begin
 if auth.uid() is null then raise exception 'Authentication required';end if;
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 1 and 500 or pg_column_size(records)>5242880 then raise exception 'Invalid import size';end if;
 if length(batch_source_type)>100 or length(coalesce(batch_filename,''))>255 then raise exception 'Import metadata too long';end if;
 perform pg_advisory_xact_lock(hashtext('calendar-ingest:'||auth.uid()::text));
 if (select count(*) from public.ingestion_batches where user_id=auth.uid() and created_at>now()-interval '1 minute')>=10 then raise exception 'Import rate limit';end if;
 insert into public.ingestion_batches(user_id,source_type,filename) values(auth.uid(),coalesce(batch_source_type,'manual'),batch_filename) returning id into batch;
 for record in select value from jsonb_array_elements(records) loop
  if jsonb_typeof(record->'payload')<>'object' then raise exception 'Invalid event payload';end if;
  if nullif(record->'source'->>'url','') is not null and record->'source'->>'url' !~ '^https?://' then raise exception 'Invalid source URL';end if;
  if nullif(record->'payload'->>'meeting_url','') is not null and record->'payload'->>'meeting_url' !~ '^https?://' then raise exception 'Invalid meeting URL';end if;
  insert into public.change_proposals(user_id,batch_id,event_id,expected_version,payload,source,warnings)
  values(auth.uid(),batch,nullif(record->>'event_id','')::uuid,(record->>'expected_version')::integer,record->'payload',coalesce(record->'source','{}'),coalesce(record->'warnings','[]')) returning id into proposal;
  event_id=public.confirm_proposal(proposal,true);result=array_append(result,event_id);
 end loop;
 return result;
end $$;
revoke all on function public.ingest_calendar_records(jsonb,text,text) from public,anon;
grant execute on function public.ingest_calendar_records(jsonb,text,text) to authenticated;
create or replace function public.confirm_all_calendar_events() returns integer language plpgsql security definer set search_path=public as $$
declare e public.events;n integer:=0;begin
 if auth.uid() is null then raise exception 'Authentication required';end if;
 for e in select * from public.events where user_id=auth.uid() and deleted_at is null and status<>'confirmed' order by id for update loop
  perform public.set_event_status(e.id,e.version,'confirmed');n=n+1;
 end loop;return n;
end $$;
revoke all on function public.confirm_all_calendar_events() from public,anon;
grant execute on function public.confirm_all_calendar_events() to authenticated;
commit;
