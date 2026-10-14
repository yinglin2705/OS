create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create table public.users (
 id uuid primary key references auth.users on delete cascade,
 timezone text not null default 'Europe/London', quiet_start time default '23:00', quiet_end time default '07:00',
 reminder_intensity text not null default 'normal' check (reminder_intensity in ('low','normal','high')),
 created_at timestamptz not null default now()
);
create table public.events (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 title text not null check(length(title) between 1 and 200), category text not null default 'academic' check(category in ('academic','technical','career','social','personal','other')),
 start_at timestamptz, end_at timestamptz, deadline_at timestamptz, timezone text not null default 'Europe/London',
 location text, meeting_url text, travel_notes text, description text, preparation text, course text,
 status text not null default 'considering' check(status in ('confirmed','booked','applied','planned','considering','waiting','cancelled','completed')),
 priority text not null default 'normal' check(priority in ('high','normal','low')),
 mandatory boolean not null default false, recurring boolean not null default false, recurrence_rule text,
 attachments jsonb not null default '[]', notes text, verified_at timestamptz,
 version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(end_at is null or (start_at is not null and end_at > start_at))
);
create table public.event_sources (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 event_id uuid not null references public.events on delete cascade, url text, source_type text not null,
 notes text, original_record jsonb, verified_at timestamptz, created_at timestamptz not null default now()
);
create table public.event_status_history (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 event_id uuid not null references public.events on delete cascade, old_record jsonb, new_record jsonb not null,
 reason text, created_at timestamptz not null default now()
);
create table public.ingestion_batches (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 source_type text not null, filename text, created_at timestamptz not null default now()
);
create table public.change_proposals (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 batch_id uuid references public.ingestion_batches, event_id uuid references public.events,
 expected_version integer, payload jsonb not null, source jsonb not null, warnings jsonb not null default '[]',
 state text not null default 'pending' check(state in ('pending','accepted','rejected')), created_at timestamptz not null default now()
);
create table public.preparation_tasks (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 event_id uuid not null references public.events on delete cascade, title text not null, reason text not null,
 due_at timestamptz, completed boolean not null default false, created_at timestamptz not null default now()
);
create table public.reminder_jobs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 event_id uuid not null references public.events on delete cascade, task_id uuid references public.preparation_tasks on delete cascade,
 due_at timestamptz not null, priority text not null default 'normal',
 state text not null default 'proposed' check(state in ('proposed','approved','disabled','sent')),
 reason text not null, created_at timestamptz not null default now()
);
create table public.telegram_connections (
 user_id uuid primary key references public.users on delete cascade, chat_id bigint not null unique,
 connected_at timestamptz not null default now()
);
create table public.telegram_link_codes (
 code_hash text primary key, user_id uuid not null references public.users on delete cascade,
 expires_at timestamptz not null, consumed_at timestamptz
);
create table public.scheduled_briefings (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 kind text not null check(kind in ('morning','tomorrow','weekly')), local_time time not null,
 enabled boolean not null default true, unique(user_id,kind)
);
create table public.notification_deliveries (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
 idempotency_key text not null unique, kind text not null, reminder_id uuid references public.reminder_jobs,
 scheduled_at timestamptz not null, next_attempt_at timestamptz not null default now(),
 state text not null default 'pending' check(state in ('pending','sending','sent','failed','uncertain')),
 attempts integer not null default 0, lease_until timestamptz, delivered_at timestamptz, telegram_message_id bigint,
 error text, created_at timestamptz not null default now()
);
create index on public.events(user_id,start_at);
create index on public.notification_deliveries(state,next_attempt_at);
create index on public.reminder_jobs(user_id,due_at);

create function public.on_signup() returns trigger language plpgsql security definer set search_path=public,extensions as $$
begin
 insert into public.users(id) values(new.id);
 insert into public.scheduled_briefings(user_id,kind,local_time) values(new.id,'morning','07:00'),(new.id,'tomorrow','22:00'),(new.id,'weekly','19:00');
 return new;
end $$;
create trigger signup after insert on auth.users for each row execute function public.on_signup();
-- Backfill accounts that existed before this migration.
insert into public.users(id) select id from auth.users on conflict do nothing;
insert into public.scheduled_briefings(user_id,kind,local_time)
select u.id,k.kind,k.t::time from public.users u cross join (values('morning','07:00'),('tomorrow','22:00'),('weekly','19:00')) k(kind,t) on conflict do nothing;

create function public.audit_event() returns trigger language plpgsql security definer set search_path=public,extensions as $$
begin
 if TG_OP='UPDATE' then new.version=old.version+1; new.updated_at=now(); end if;
 insert into public.event_status_history(user_id,event_id,old_record,new_record,reason)
 values(new.user_id,new.id,case when TG_OP='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),'Confirmed user change');
 return new;
end $$;
create trigger audit after insert or update on public.events for each row execute function public.audit_event();
-- Version must be assigned before the row is written.
create function public.event_version() returns trigger language plpgsql as $$ begin new.version=old.version+1; new.updated_at=now(); return new; end $$;
create trigger event_version before update on public.events for each row execute function public.event_version();

create function public.prepare_event() returns trigger language plpgsql security definer set search_path=public,extensions as $$
declare d integer; task uuid; due timestamptz;
begin
 if TG_OP='UPDATE' then
  if row(new.status,new.start_at,new.deadline_at,new.preparation,new.description,new.location,new.travel_notes,new.category,new.priority,new.title) is not distinct from row(old.status,old.start_at,old.deadline_at,old.preparation,old.description,old.location,old.travel_notes,old.category,old.priority,old.title) then return new; end if;
  update public.reminder_jobs set state='disabled' where event_id=new.id and state in ('proposed','approved');
  update public.preparation_tasks set completed=true where event_id=new.id and not completed;
 end if;
 if new.status not in ('confirmed','booked') then return new; end if;
 if new.deadline_at is not null then
  for d in select unnest(case when new.priority='high' or new.category='academic' then array[7,3,1] else array[1] end) loop
   due=((new.deadline_at at time zone new.timezone)-make_interval(days=>d)) at time zone new.timezone;
   if due>now() then
    insert into public.preparation_tasks(user_id,event_id,title,reason,due_at) values(new.user_id,new.id,'准备截止事项：'||new.title,'根据任务类别与优先级，在截止前 '||d||' 天检查进度',due) returning id into task;
    insert into public.reminder_jobs(user_id,event_id,task_id,due_at,priority,reason) values(new.user_id,new.id,task,due,new.priority,'截止前进度检查；需用户批准');
   end if;
  end loop;
 end if;
 if new.start_at is not null and new.start_at-interval '1 day'>now() then
  insert into public.preparation_tasks(user_id,event_id,title,reason,due_at)
  values(new.user_id,new.id,coalesce(nullif(new.preparation,''),case when lower(new.title||' '||coalesce(new.description,'')) ~ 'stage crew|core training|舞台' then '核实安全鞋、会员资格与安全培训要求（以来源为准）' when lower(new.title||' '||coalesce(new.description,'')) ~ 'workshop|b-made|工作坊|cnc' then '核实所需材料、装备、注册要求与预约链接' when lower(new.title||' '||coalesce(new.description,'')) ~ 'presentation|演示|汇报' then '准备幻灯片并安排排练，核实提交格式' else '核实地点、交通与预约链接' end),'活动前一天检查准备；未提供的装备要求仍需核实',((new.start_at at time zone new.timezone)-interval '1 day') at time zone new.timezone) returning id into task;
  insert into public.reminder_jobs(user_id,event_id,task_id,due_at,priority,reason) values(new.user_id,new.id,task,((new.start_at at time zone new.timezone)-interval '1 day') at time zone new.timezone,new.priority,'提前一天准备；需用户批准');
 end if;
 if new.start_at is not null and lower(new.title||' '||coalesce(new.description,'')) ~ 'presentation|演示|汇报' and new.start_at-interval '3 days'>now() then
  due=((new.start_at at time zone new.timezone)-interval '3 days') at time zone new.timezone;
  insert into public.preparation_tasks(user_id,event_id,title,reason,due_at) values(new.user_id,new.id,'准备幻灯片并预约排练时间','演示任务通常需要制作和练习，建议提前三天',due) returning id into task;
  insert into public.reminder_jobs(user_id,event_id,task_id,due_at,priority,reason) values(new.user_id,new.id,task,due,new.priority,'演示准备需要较长提前量；需用户批准');
 end if;
 if new.start_at is not null and (new.travel_notes is not null or new.location is not null) and new.start_at-interval '1 hour'>now() then
  due=new.start_at-interval '1 hour';
  insert into public.preparation_tasks(user_id,event_id,title,reason,due_at) values(new.user_id,new.id,'核实路线、出发和到场时间','默认提前一小时检查交通，不代表已核实的旅途时长；可编辑',due) returning id into task;
  insert into public.reminder_jobs(user_id,event_id,task_id,due_at,priority,reason) values(new.user_id,new.id,task,due,new.priority,'有地点或交通备注，建议留出出发检查时间；需用户批准');
 end if;
 return new;
end $$;
create trigger preparation after insert or update on public.events for each row execute function public.prepare_event();

-- All client access is scoped to the authenticated owner.
do $$ declare t text; begin
 foreach t in array array['users','events','event_sources','event_status_history','ingestion_batches','change_proposals','preparation_tasks','reminder_jobs','telegram_connections','scheduled_briefings','notification_deliveries'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy owner_read on public.%I for select to authenticated using (%I=auth.uid())',t,case when t='users' then 'id' else 'user_id' end);
 end loop;
 foreach t in array array['users','preparation_tasks','reminder_jobs','scheduled_briefings'] loop
  execute format('create policy owner_update on public.%I for update to authenticated using (%I=auth.uid()) with check (%I=auth.uid())',t,case when t='users' then 'id' else 'user_id' end,case when t='users' then 'id' else 'user_id' end);
 end loop;
end $$;
alter table public.telegram_link_codes enable row level security;
create policy unlink on public.telegram_connections for delete to authenticated using(user_id=auth.uid());
-- Limit client-writable fields: IDs, ownership, delivery records and audit data are immutable.
revoke all on all tables in schema public from anon;
revoke insert,update,delete on all tables in schema public from authenticated;
grant select on public.users,public.events,public.event_sources,public.event_status_history,public.ingestion_batches,public.change_proposals,public.preparation_tasks,public.reminder_jobs,public.telegram_connections,public.scheduled_briefings,public.notification_deliveries to authenticated;
grant update(timezone,quiet_start,quiet_end,reminder_intensity) on public.users to authenticated;
grant update(completed) on public.preparation_tasks to authenticated;
grant update(due_at,state) on public.reminder_jobs to authenticated;
grant update(local_time,enabled) on public.scheduled_briefings to authenticated;
grant delete on public.telegram_connections to authenticated;

create function public.confirm_proposal(proposal_id uuid, accept boolean) returns uuid
language plpgsql security definer set search_path=public,extensions as $$
declare p public.change_proposals; e public.events; result uuid; v jsonb;
begin
 select * into p from public.change_proposals where id=proposal_id and user_id=auth.uid() for update;
 if not found or p.state<>'pending' then raise exception 'Proposal unavailable'; end if;
 if not accept then update public.change_proposals set state='rejected' where id=p.id; return null; end if;
 v=p.payload;
 if p.event_id is not null then
  select * into e from public.events where id=p.event_id and user_id=auth.uid() for update;
  if not found or e.version<>p.expected_version then raise exception 'Event changed; refresh proposal'; end if;
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
 update public.change_proposals set state='accepted' where id=p.id;
 return result;
end $$;
revoke all on function public.confirm_proposal(uuid,boolean) from public;
grant execute on function public.confirm_proposal(uuid,boolean) to authenticated;

create function public.consume_link(code text, private_chat bigint) returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare uid uuid;
begin
 update public.telegram_link_codes set consumed_at=now() where code_hash=encode(digest(code,'sha256'),'hex') and consumed_at is null and expires_at>now() returning user_id into uid;
 if uid is null then return null; end if;
 update public.telegram_link_codes set consumed_at=now() where user_id=uid and consumed_at is null;
 insert into public.telegram_connections(user_id,chat_id) values(uid,private_chat) on conflict(user_id) do update set chat_id=excluded.chat_id,connected_at=now();
 insert into public.notification_deliveries(user_id,idempotency_key,kind,scheduled_at) values(uid,'link:'||encode(digest(code,'sha256'),'hex'),'test',now()) on conflict do nothing;
 return uid;
end $$;

-- Atomic claim + lease. Unknown network outcomes never auto-retry: Telegram has no idempotency API.
create function public.claim_deliveries() returns setof public.notification_deliveries language plpgsql security definer set search_path=public,extensions as $$
begin
 update public.notification_deliveries set state='uncertain',error='Worker lease expired; delivery outcome unknown' where state='sending' and lease_until<now();
 return query update public.notification_deliveries d set state='sending',attempts=attempts+1,lease_until=now()+interval '2 minutes'
 where d.id in (select n.id from public.notification_deliveries n where n.state='pending' and n.next_attempt_at<=now() and exists(select 1 from public.telegram_connections c where c.user_id=n.user_id) order by n.scheduled_at for update skip locked limit 5) returning d.*;
end $$;
create function public.enqueue_due() returns void language plpgsql security definer set search_path=public,extensions as $$
begin
 insert into public.notification_deliveries(user_id,idempotency_key,kind,scheduled_at)
 select s.user_id,'brief:'||s.id||':'||(tick at time zone u.timezone)::date,s.kind,tick
 from public.scheduled_briefings s join public.users u on u.id=s.user_id
 cross join generate_series(date_trunc('minute',now())-interval '5 minutes',date_trunc('minute',now()),interval '1 minute') tick
 where s.enabled and (tick at time zone u.timezone)::time=s.local_time
 and (s.kind<>'weekly' or extract(isodow from tick at time zone u.timezone)=7)
 and exists(select 1 from public.telegram_connections c where c.user_id=s.user_id)
 on conflict(idempotency_key) do nothing;
 insert into public.notification_deliveries(user_id,idempotency_key,kind,reminder_id,scheduled_at)
 select r.user_id,'reminder:'||r.id||':'||r.due_at,'preparation',r.id,r.due_at from public.reminder_jobs r join public.events e on e.id=r.event_id
 where r.state='approved' and r.due_at<=now() and r.due_at>now()-interval '1 day' and e.status in ('confirmed','booked')
 and exists(select 1 from public.telegram_connections c where c.user_id=r.user_id)
 on conflict(idempotency_key) do nothing;
end $$;
do $$ declare f text; begin foreach f in array array['consume_link(text,bigint)','claim_deliveries()','enqueue_due()'] loop
 execute 'revoke all on function public.'||f||' from public,anon,authenticated';
 execute 'grant execute on function public.'||f||' to service_role';
end loop; end $$;

create function public.validate_preferences() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from pg_timezone_names where name=new.timezone) then raise exception 'Invalid IANA timezone'; end if;
 if (new.quiet_start is null) <> (new.quiet_end is null) then raise exception 'Set both quiet hour boundaries or clear both'; end if;
 return new;
end $$;
create trigger preferences before insert or update on public.users for each row execute function public.validate_preferences();
alter table public.scheduled_briefings add constraint minute_precision check(extract(second from local_time)=0);
