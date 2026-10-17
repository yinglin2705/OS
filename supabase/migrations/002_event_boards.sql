begin;
select pg_advisory_xact_lock(hashtext('ying-os-event-boards-v1'));
create unique index if not exists events_id_owner on public.events(id,user_id);
create table if not exists public.event_board_cards (
 id uuid primary key default gen_random_uuid(),
 event_id uuid not null,
 user_id uuid not null default auth.uid(),
 kind text not null check(kind in ('note','link','image')),
 title text not null default '' check(length(title)<=200),
 body text not null default '' check(length(body)<=10000),
 url text check(url is null or (length(url)<=2000 and url ~ '^https?://')),
 image_path text,
 x integer not null default 40 check(x between 0 and 1700),
 y integer not null default 40 check(y between 0 and 1700),
 created_at timestamptz not null default now(),
 foreign key(event_id,user_id) references public.events(id,user_id) on delete cascade,
 unique(id,event_id,user_id),
 check ((kind='image' and image_path is not null and image_path like user_id::text||'/'||event_id::text||'/%') or (kind<>'image' and image_path is null)),
 check(kind<>'link' or url is not null)
);
create table if not exists public.event_board_edges (
 id uuid primary key default gen_random_uuid(),
 event_id uuid not null,
 user_id uuid not null default auth.uid(),
 from_card uuid not null,
 to_card uuid not null,
 created_at timestamptz not null default now(),
 foreign key(from_card,event_id,user_id) references public.event_board_cards(id,event_id,user_id) on delete cascade,
 foreign key(to_card,event_id,user_id) references public.event_board_cards(id,event_id,user_id) on delete cascade,
 check(from_card<>to_card),
 unique(event_id,from_card,to_card)
);
alter table public.event_board_cards enable row level security;
alter table public.event_board_edges enable row level security;
do $$ declare t text; begin
 foreach t in array array['event_board_cards','event_board_edges'] loop
 if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='board_owner') then
 execute format('create policy board_owner on public.%I for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid())',t);
 end if;
 execute format('grant select,insert,update,delete on public.%I to authenticated',t);
 end loop;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('event-board','event-board',false,8388608,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='event_board_owner') then
 create policy event_board_owner on storage.objects for all to authenticated
 using(bucket_id='event-board' and (storage.foldername(name))[1]=auth.uid()::text)
 with check(bucket_id='event-board' and (storage.foldername(name))[1]=auth.uid()::text and exists(
 select 1 from public.events e where e.user_id=auth.uid() and e.id::text=(storage.foldername(name))[2]));
 end if;
end $$;
commit;
