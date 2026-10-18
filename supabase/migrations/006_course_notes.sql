begin;
select pg_advisory_xact_lock(hashtext('ying-os-course-notes-v1'));
create table if not exists public.notes(
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references public.users on delete cascade,
 title text not null check(length(title) between 1 and 200),course text not null default '未分类' check(length(course) between 1 and 200),
 lesson_date date,body text not null default '' check(length(body)<=100000),tags text[] not null default '{}' check(cardinality(tags)<=20),
 source_fingerprint text,version integer not null default 1,deleted_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id)
);
create index if not exists notes_owner_course on public.notes(user_id,lower(course),lesson_date);
create table if not exists public.note_sources(
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid(),note_id uuid not null,
 source_type text not null,original_text text not null check(length(original_text)<=200000),source_label text,source_url text check(source_url is null or source_url ~ '^https?://'),
 fingerprint text,created_at timestamptz not null default now(),foreign key(note_id,user_id) references public.notes(id,user_id) on delete cascade
);
create table if not exists public.note_revisions(
 id uuid primary key default gen_random_uuid(),user_id uuid not null,note_id uuid not null,old_record jsonb,new_record jsonb not null,created_at timestamptz not null default now(),
 foreign key(note_id,user_id) references public.notes(id,user_id) on delete cascade
);
create table if not exists public.note_event_links(
 note_id uuid not null,event_id uuid not null,user_id uuid not null default auth.uid(),primary key(note_id,event_id),
 foreign key(note_id,user_id) references public.notes(id,user_id) on delete cascade,foreign key(event_id,user_id) references public.events(id,user_id) on delete cascade
);
create table if not exists public.note_links(
 from_note uuid not null,to_note uuid not null,user_id uuid not null default auth.uid(),primary key(from_note,to_note),check(from_note<>to_note),
 foreign key(from_note,user_id) references public.notes(id,user_id) on delete cascade,foreign key(to_note,user_id) references public.notes(id,user_id) on delete cascade
);
create table if not exists public.note_card_links(
 note_id uuid not null,card_id uuid not null,event_id uuid not null,user_id uuid not null default auth.uid(),primary key(note_id,card_id),
 foreign key(note_id,user_id) references public.notes(id,user_id) on delete cascade,
 foreign key(card_id,event_id,user_id) references public.event_board_cards(id,event_id,user_id) on delete cascade
);
create table if not exists public.note_import_batches(
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references public.users on delete cascade,
 course text not null,source_text text not null check(length(source_text)<=200000),source_label text not null,engine text not null check(engine in ('rules','ai')),
 source_hash text not null,state text not null default 'pending' check(state in ('pending','accepted')),created_at timestamptz not null default now()
);
create table if not exists public.note_import_proposals(
 id uuid primary key default gen_random_uuid(),batch_id uuid not null,user_id uuid not null default auth.uid(),payload jsonb not null,
 action text not null default 'review' check(action in ('create','update','skip','review')),target_note_id uuid,
 expected_version integer,warnings text[] not null default '{}',state text not null default 'pending' check(state in ('pending','accepted')),
 created_at timestamptz not null default now()
);
alter table public.note_sources add column if not exists batch_id uuid references public.note_import_batches on delete set null;
create unique index if not exists note_batches_id_owner on public.note_import_batches(id,user_id);
do $$ begin
 if not exists(select 1 from pg_constraint where conname='note_proposal_batch_owner') then
 alter table public.note_import_proposals add constraint note_proposal_target_owner foreign key(target_note_id,user_id) references public.notes(id,user_id) on delete set null(target_note_id);
 alter table public.note_import_proposals add constraint note_proposal_batch_owner foreign key(batch_id,user_id) references public.note_import_batches(id,user_id) on delete cascade;end if;
end $$;
do $$ declare t text;begin
 foreach t in array array['notes','note_sources','note_revisions','note_event_links','note_links','note_card_links','note_import_batches','note_import_proposals'] loop
 execute format('alter table public.%I enable row level security',t);
 if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='note_owner') then
 execute format('create policy note_owner on public.%I for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid())',t);end if;
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
grant insert(user_id,title,course,lesson_date,body,tags) on public.notes to authenticated;
grant update(title,course,lesson_date,body,tags) on public.notes to authenticated;
grant insert(user_id,note_id,source_type,original_text,source_label,source_url,fingerprint) on public.note_sources to authenticated;
grant insert(user_id,note_id,event_id),delete on public.note_event_links to authenticated;
grant insert(user_id,note_id,card_id,event_id),delete on public.note_card_links to authenticated;
grant insert(user_id,from_note,to_note),delete on public.note_links to authenticated;
grant insert(user_id,course,source_text,source_label,engine,source_hash) on public.note_import_batches to authenticated;
grant insert(user_id,batch_id,payload,action,target_note_id,expected_version,warnings) on public.note_import_proposals to authenticated;
grant update(payload,action,target_note_id,expected_version,warnings) on public.note_import_proposals to authenticated;
create or replace function public.note_audit() returns trigger language plpgsql security definer set search_path=public as $$ begin
 insert into public.note_revisions(user_id,note_id,old_record,new_record) values(new.user_id,new.id,case when TG_OP='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));return new;end $$;
drop trigger if exists note_audit on public.notes;
-- Revision FK needs the new row to exist before insertion.
create or replace function public.note_version() returns trigger language plpgsql as $$ begin new.version=old.version+1;new.updated_at=now();return new;end $$;
drop trigger if exists note_version on public.notes;
create trigger note_version before update on public.notes for each row execute function public.note_version();
create trigger note_audit after insert or update on public.notes for each row execute function public.note_audit();
create or replace function public.guard_note_preview() returns trigger language plpgsql set search_path=public as $$ begin
 if exists(select 1 from public.note_import_batches where id=new.batch_id and user_id=new.user_id and state='pending') then return new;end if;
 if TG_OP='UPDATE' and new.target_note_id is null and (to_jsonb(new)-'target_note_id')=(to_jsonb(old)-'target_note_id') then return new;end if;
 raise exception 'Accepted import preview is immutable';end $$;
drop trigger if exists guard_note_preview on public.note_import_proposals;
create trigger guard_note_preview before insert or update on public.note_import_proposals for each row execute function public.guard_note_preview();
create or replace function public.confirm_note_batch(target uuid) returns integer language plpgsql security definer set search_path=public as $$
declare b public.note_import_batches;p public.note_import_proposals;v jsonb;n uuid;counted integer:=0;ev text;ref text;other uuid;matches integer;begin
 select * into b from public.note_import_batches where id=target and user_id=auth.uid() for update;
 if not found then raise exception 'Batch unavailable';end if;if b.state='accepted' then return 0;end if;
 for p in select * from public.note_import_proposals where batch_id=target and user_id=auth.uid() and state='pending' order by created_at,id for update loop
  if p.action='review' then raise exception 'Resolve duplicate review before confirmation';end if;
  if p.action='skip' then update public.note_import_proposals set state='accepted' where id=p.id;continue;end if;
  v=p.payload;
  if jsonb_typeof(v->'tags')<>'array' or jsonb_typeof(v->'event_ids')<>'array' or jsonb_typeof(v->'related_titles')<>'array' then raise exception 'Invalid payload';end if;
  if p.action='update' then
   select id into n from public.notes where id=p.target_note_id and user_id=auth.uid() and deleted_at is null and version=p.expected_version for update;
   if not found then raise exception 'Note changed; refresh preview';end if;
   update public.notes set title=v->>'title',course=v->>'course',lesson_date=nullif(v->>'lesson_date','')::date,body=v->>'body',tags=array(select jsonb_array_elements_text(v->'tags')),source_fingerprint=v->>'fingerprint' where id=n;
  else
   insert into public.notes(user_id,title,course,lesson_date,body,tags,source_fingerprint) values(auth.uid(),v->>'title',v->>'course',nullif(v->>'lesson_date','')::date,v->>'body',array(select jsonb_array_elements_text(v->'tags')),v->>'fingerprint') returning id into n;
  end if;
  insert into public.note_sources(user_id,note_id,source_type,original_text,source_label,fingerprint,batch_id) values(auth.uid(),n,case when b.engine='ai' then 'ai_chat_import_unverified' else 'rule_chat_import_unverified' end,v->>'source_excerpt',b.source_label,v->>'fingerprint',b.id);
  for ev in select jsonb_array_elements_text(v->'event_ids') loop
   if not exists(select 1 from public.events where id=ev::uuid and user_id=auth.uid() and deleted_at is null) then raise exception 'Related event unavailable';end if;
   insert into public.note_event_links(note_id,event_id,user_id) values(n,ev::uuid,auth.uid()) on conflict do nothing;
  end loop;
  update public.note_import_proposals set state='accepted',target_note_id=n where id=p.id;counted=counted+1;
 end loop;
 -- Resolve references after all notes in this batch exist, avoiding guessed links on duplicate titles.
 for p in select * from public.note_import_proposals where batch_id=target and user_id=auth.uid() and action in ('create','update') loop
  for ref in select jsonb_array_elements_text(p.payload->'related_titles') loop
   select count(*),(array_agg(id))[1] into matches,other from public.notes where user_id=auth.uid() and deleted_at is null and lower(title)=lower(ref);
   if matches=1 and other<>p.target_note_id then insert into public.note_links(user_id,from_note,to_note) values(auth.uid(),p.target_note_id,other) on conflict do nothing;end if;
  end loop;
 end loop;
 update public.note_import_batches set state='accepted' where id=target;return counted;
end $$;
create or replace function public.trash_note(target uuid,restore boolean default false) returns void language plpgsql security definer set search_path=public as $$ begin
 update public.notes set deleted_at=case when restore then null else now() end where id=target and user_id=auth.uid();if not found then raise exception 'Note unavailable';end if;end $$;
create or replace function public.delete_note_record(record_type text,target uuid) returns void language plpgsql security definer set search_path=public as $$ begin
 case record_type
 when 'note' then delete from public.notes where id=target and user_id=auth.uid() and deleted_at is not null;
 when 'batch' then delete from public.note_import_batches where id=target and user_id=auth.uid();
 when 'source' then delete from public.note_sources where id=target and user_id=auth.uid();
 when 'revision' then delete from public.note_revisions where id=target and user_id=auth.uid();
 when 'proposal' then delete from public.note_import_proposals where id=target and user_id=auth.uid();
 else raise exception 'Unsupported note record type';end case;
 if not found then raise exception 'Record unavailable';end if;end $$;
do $$ declare f text;begin foreach f in array array['confirm_note_batch(uuid)','trash_note(uuid,boolean)','delete_note_record(text,uuid)'] loop
 execute 'revoke all on function public.'||f||' from public,anon';execute 'grant execute on function public.'||f||' to authenticated';end loop;end $$;
-- Unified search includes active standalone notes as well as active events/cards.
drop function if exists public.search_knowledge(text);
create function public.search_knowledge(search_text text)
returns table(node_id text,event_id uuid,card_id uuid,note_id uuid,title text,excerpt text,kind text,start_at timestamptz)
language sql stable security invoker set search_path=public as $$
 select * from (
 select 'event:'||e.id,e.id,null::uuid,null::uuid,e.title,left(concat_ws(' · ',e.description,e.notes,e.location,e.course,e.preparation),700),'event',e.start_at
 from public.events e where e.deleted_at is null and length(btrim(search_text)) between 1 and 200 and strpos(lower(concat_ws(' ',e.title,e.description,e.notes,e.location,e.course,e.preparation)),lower(btrim(search_text)))>0
 union all
 select 'card:'||c.id,c.event_id,c.id,null::uuid,coalesce(nullif(c.title,''),c.original_filename,'未命名便签'),left(c.body,700),c.kind,null::timestamptz
 from public.event_board_cards c join public.events e on e.id=c.event_id where e.deleted_at is null and length(btrim(search_text)) between 1 and 200 and strpos(lower(concat_ws(' ',c.title,c.body,c.url,c.original_filename)),lower(btrim(search_text)))>0
 union all
 select 'note:'||n.id,null::uuid,null::uuid,n.id,n.title,left(n.body,700),'class_note',null::timestamptz
 from public.notes n where n.deleted_at is null and length(btrim(search_text)) between 1 and 200 and strpos(lower(concat_ws(' ',n.title,n.course,n.body,array_to_string(n.tags,' '))),lower(btrim(search_text)))>0
 ) matches order by 5,1 limit 200;
$$;
revoke all on function public.search_knowledge(text) from public;
grant execute on function public.search_knowledge(text) to authenticated;
commit;
