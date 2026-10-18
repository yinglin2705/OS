begin;
select pg_advisory_xact_lock(hashtext('ying-os-deletion-v1'));
alter table public.events add column if not exists deleted_at timestamptz;
alter table public.events add column if not exists trash_status text;
create table if not exists public.file_deletion_jobs(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.users on delete cascade,
 path text not null check(path like user_id::text||'/%'),created_at timestamptz not null default now(),unique(user_id,path)
);
alter table public.file_deletion_jobs enable row level security;
do $$ begin if not exists(select 1 from pg_policies where tablename='file_deletion_jobs' and policyname='file_cleanup_owner') then
 create policy file_cleanup_owner on public.file_deletion_jobs for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());end if;end $$;
revoke all on public.file_deletion_jobs from anon,authenticated;
grant select,delete on public.file_deletion_jobs to authenticated;
create table if not exists public.notification_tombstones(user_id uuid not null references public.users on delete cascade,fingerprint text primary key);
alter table public.notification_tombstones enable row level security;
revoke all on public.notification_tombstones from anon,authenticated;
create or replace function public.remember_deleted_delivery() returns trigger language plpgsql security definer set search_path=public,extensions as $$ begin
 if exists(select 1 from public.users where id=old.user_id) then insert into public.notification_tombstones(user_id,fingerprint) values(old.user_id,encode(digest(old.idempotency_key,'sha256'),'hex')) on conflict do nothing;end if;return old;end $$;
drop trigger if exists remember_delivery_delete on public.notification_deliveries;
create trigger remember_delivery_delete before delete on public.notification_deliveries for each row execute function public.remember_deleted_delivery();
create or replace function public.trash_event(target uuid,restore boolean default false) returns void language plpgsql security definer set search_path=public as $$
declare e public.events;begin
 select * into e from public.events where id=target and user_id=auth.uid() for update;
 if not found then raise exception 'Event unavailable';end if;
 if restore then
  if e.deleted_at is null then return;end if;
  update public.events set status=coalesce(trash_status,'planned'),deleted_at=null,trash_status=null where id=target;
 else
  if e.deleted_at is not null then return;end if;
  update public.events set trash_status=status,status='cancelled',deleted_at=now() where id=target;
  update public.reminder_jobs set state='disabled' where event_id=target and state in ('proposed','approved');
  update public.preparation_tasks set completed=true where event_id=target;
  update public.notification_deliveries set state='failed',error='Event moved to trash' where state='pending' and reminder_id in(select id from public.reminder_jobs where event_id=target);
 end if;
end $$;
create or replace function public.purge_event(target uuid) returns void language plpgsql security definer set search_path=public as $$
declare e public.events;begin
 select * into e from public.events where id=target and user_id=auth.uid() and deleted_at is not null for update;
 if not found then raise exception 'Trashed event unavailable';end if;
 if exists(select 1 from public.notification_deliveries where state='sending' and reminder_id in(select id from public.reminder_jobs where event_id=target)) then raise exception 'Reminder sending; retry later';end if;
 insert into public.file_deletion_jobs(user_id,path) select user_id,image_path from public.event_board_cards where event_id=target and image_path is not null on conflict do nothing;
 delete from public.notification_deliveries where reminder_id in(select id from public.reminder_jobs where event_id=target);
 delete from public.change_proposals where user_id=auth.uid() and event_id=target;
 delete from public.events where id=target;
end $$;
create or replace function public.delete_owned_record(record_type text,target uuid) returns void language plpgsql security definer set search_path=public as $$
declare result uuid; c public.event_board_cards;begin
 case record_type
 when 'card' then
  select * into c from public.event_board_cards where id=target and user_id=auth.uid() for update;
  if not found then raise exception 'Card unavailable';end if;
  if c.image_path is not null then insert into public.file_deletion_jobs(user_id,path) values(auth.uid(),c.image_path) on conflict do nothing;end if;
  delete from public.event_board_cards where id=target returning id into result;
 when 'task','reminder' then
  if record_type='task' then
   if not exists(select 1 from public.preparation_tasks where id=target and user_id=auth.uid()) then raise exception 'Task unavailable';end if;
  else if not exists(select 1 from public.reminder_jobs where id=target and user_id=auth.uid()) then raise exception 'Reminder unavailable';end if;end if;
  if exists(select 1 from public.notification_deliveries d join public.reminder_jobs r on r.id=d.reminder_id where r.user_id=auth.uid() and (r.id=target or r.task_id=target) and d.state='sending') then raise exception 'Reminder sending; retry later';end if;
  delete from public.notification_deliveries where reminder_id in(select id from public.reminder_jobs where user_id=auth.uid() and (id=target or task_id=target));
  if record_type='task' then delete from public.preparation_tasks where id=target and user_id=auth.uid() returning id into result;
  else delete from public.reminder_jobs where id=target and user_id=auth.uid() returning id into result;end if;
 when 'briefing' then
  if exists(select 1 from public.notification_deliveries d join public.scheduled_briefings b on b.kind=d.kind and b.user_id=d.user_id where b.id=target and b.user_id=auth.uid() and d.state='sending') then raise exception 'Briefing sending; retry later';end if;
  delete from public.notification_deliveries where state='pending' and user_id=auth.uid() and kind in(select kind from public.scheduled_briefings where id=target and user_id=auth.uid());
  delete from public.scheduled_briefings where id=target and user_id=auth.uid() returning id into result;
 when 'proposal' then delete from public.change_proposals where id=target and user_id=auth.uid() returning id into result;
 when 'batch' then
  delete from public.change_proposals where batch_id=target and user_id=auth.uid();
  delete from public.ingestion_batches where id=target and user_id=auth.uid() returning id into result;
 when 'source' then delete from public.event_sources where id=target and user_id=auth.uid() returning id into result;
 when 'history' then delete from public.event_status_history where id=target and user_id=auth.uid() returning id into result;
 when 'delivery' then delete from public.notification_deliveries where id=target and user_id=auth.uid() and state<>'sending' returning id into result;
 when 'board_edge' then delete from public.event_board_edges where id=target and user_id=auth.uid() returning id into result;
 when 'knowledge_link' then delete from public.knowledge_links where id=target and user_id=auth.uid() returning id into result;
 when 'highlight' then delete from public.board_highlights where id=target and user_id=auth.uid() returning id into result;
 else raise exception 'Unsupported record type';end case;
 if result is null then raise exception 'Record unavailable or still sending';end if;
end $$;
create or replace function public.clear_owned_records(record_type text) returns integer language plpgsql security definer set search_path=public as $$
declare n integer;begin
 if record_type='pending_proposals' then delete from public.change_proposals where user_id=auth.uid() and state='pending';
 elsif record_type='history' then delete from public.event_status_history where user_id=auth.uid();
 elsif record_type='deliveries' then delete from public.notification_deliveries where user_id=auth.uid() and state in ('sent','failed','uncertain');
 else raise exception 'Unsupported record type';end if;
 get diagnostics n=row_count;return n;
end $$;
do $$ declare f text;begin foreach f in array array['trash_event(uuid,boolean)','purge_event(uuid)','delete_owned_record(text,uuid)','clear_owned_records(text)'] loop
 execute 'revoke all on function public.'||f||' from public,anon';execute 'grant execute on function public.'||f||' to authenticated';end loop;end $$;
create or replace function public.enqueue_due() returns void language plpgsql security definer set search_path=public,extensions as $$
begin
 insert into public.notification_deliveries(user_id,idempotency_key,kind,scheduled_at)
 select s.user_id,'brief:'||s.id||':'||(tick at time zone u.timezone)::date,s.kind,tick
 from public.scheduled_briefings s join public.users u on u.id=s.user_id
 cross join generate_series(date_trunc('minute',now())-interval '5 minutes',date_trunc('minute',now()),interval '1 minute') tick
 where s.enabled and (tick at time zone u.timezone)::time=s.local_time
 and (s.kind<>'weekly' or extract(isodow from tick at time zone u.timezone)=7)
 and not exists(select 1 from public.notification_tombstones t where t.fingerprint=encode(digest('brief:'||s.id||':'||(tick at time zone u.timezone)::date,'sha256'),'hex'))
 and exists(select 1 from public.telegram_connections c where c.user_id=s.user_id)
 on conflict(idempotency_key) do nothing;
 insert into public.notification_deliveries(user_id,idempotency_key,kind,reminder_id,scheduled_at)
 select r.user_id,'reminder:'||r.id||':'||r.due_at,'preparation',r.id,r.due_at from public.reminder_jobs r join public.events e on e.id=r.event_id
 where e.deleted_at is null and not exists(select 1 from public.notification_tombstones t where t.fingerprint=encode(digest('reminder:'||r.id||':'||r.due_at,'sha256'),'hex')) and r.state='approved' and r.due_at<=now() and r.due_at>now()-interval '1 day' and e.status in ('confirmed','booked')
 and exists(select 1 from public.telegram_connections c where c.user_id=r.user_id)
 on conflict(idempotency_key) do nothing;
end $$;
create or replace function public.confirm_proposal(proposal_id uuid, accept boolean) returns uuid
language plpgsql security definer set search_path=public,extensions as $$
declare p public.change_proposals; e public.events; result uuid; v jsonb;
begin
 select * into p from public.change_proposals where id=proposal_id and user_id=auth.uid() for update;
 if not found or p.state<>'pending' then raise exception 'Proposal unavailable'; end if;
 if not accept then update public.change_proposals set state='rejected' where id=p.id; return null; end if;
 v=p.payload;
 if p.event_id is not null then
  select * into e from public.events where id=p.event_id and user_id=auth.uid() for update;
  if not found or e.deleted_at is not null or e.version<>p.expected_version then raise exception 'Event changed; refresh proposal'; end if;
  v=to_jsonb(e)||v;
 end if;
 if nullif(v->>'title','') is null then raise exception 'Title required'; end if;
 if p.event_id is null then
  insert into public.events(user_id,title) values(auth.uid(),v->>'title') returning id into result;
 else result=p.event_id; end if;
 update public.events set title=v->>'title',category=coalesce(v->>'category','academic'),
 start_at=(v->>'start_at')::timestamptz,end_at=(v->>'end_at')::timestamptz,deadline_at=(v->>'deadline_at')::timestamptz,
 timezone=coalesce(v->>'timezone','Europe/London'),status=coalesce(v->>'status','considering'),priority=coalesce(v->>'priority','normal'),
 location=v->>'location',meeting_url=v->>'meeting_url',travel_notes=v->>'travel_notes',description=v->>'description',preparation=v->>'preparation',course=v->>'course',notes=v->>'notes',
 mandatory=coalesce((v->>'mandatory')::boolean,false),recurring=coalesce((v->>'recurring')::boolean,false),recurrence_rule=v->>'recurrence_rule',attachments=coalesce(v->'attachments','[]'::jsonb)
 where id=result and user_id=auth.uid();
 insert into public.event_sources(user_id,event_id,url,source_type,notes,original_record)
 values(auth.uid(),result,p.source->>'url',coalesce(p.source->>'source_type','manual'),p.source->>'notes',p.source);
 update public.change_proposals set state='accepted',event_id=result where id=p.id;
 return result;
end $$;

create or replace function public.clear_event_board(target uuid) returns void language plpgsql security definer set search_path=public as $$ begin
 if not exists(select 1 from public.events where id=target and user_id=auth.uid()) then raise exception 'Event unavailable';end if;
 insert into public.file_deletion_jobs(user_id,path) select user_id,image_path from public.event_board_cards where event_id=target and user_id=auth.uid() and image_path is not null on conflict do nothing;
 delete from public.event_board_cards where event_id=target and user_id=auth.uid();end $$;
revoke all on function public.clear_event_board(uuid) from public,anon;
grant execute on function public.clear_event_board(uuid) to authenticated;

create or replace function public.restore_default_briefings() returns void language plpgsql security definer set search_path=public as $$ begin
 if auth.uid() is null then raise exception 'Authentication required';end if;
 insert into public.scheduled_briefings(user_id,kind,local_time,enabled) values(auth.uid(),'morning','07:00',false),(auth.uid(),'tomorrow','22:00',false),(auth.uid(),'weekly','19:00',false) on conflict(user_id,kind) do nothing;
end $$;
revoke all on function public.restore_default_briefings() from public,anon;
grant execute on function public.restore_default_briefings() to authenticated;
commit;
