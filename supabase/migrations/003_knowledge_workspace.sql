begin;
select pg_advisory_xact_lock(hashtext('ying-os-knowledge-v1'));
alter table public.event_board_cards drop constraint if exists event_board_cards_kind_check;
alter table public.event_board_cards drop constraint if exists event_board_cards_check;
alter table public.event_board_cards drop constraint if exists board_kind_v2;
alter table public.event_board_cards drop constraint if exists board_attachment_v2;
alter table public.event_board_cards add constraint board_kind_v2 check(kind in ('note','link','image','pdf'));
alter table public.event_board_cards add constraint board_attachment_v2 check(
 (kind in ('image','pdf') and image_path is not null and image_path like user_id::text||'/'||event_id::text||'/%') or (kind not in ('image','pdf') and image_path is null));
alter table public.event_board_cards add column if not exists original_filename text check(length(original_filename)<=255);
alter table public.event_board_cards add column if not exists color text not null default 'yellow' check(color in ('yellow','pink','blue','green'));
update storage.buckets set public=false,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','application/pdf'] where id='event-board';
create table if not exists public.knowledge_links(
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid(),
 from_event uuid not null,from_card uuid,to_event uuid not null,to_card uuid,
 created_at timestamptz not null default now(),
 foreign key(from_event,user_id) references public.events(id,user_id) on delete cascade,
 foreign key(to_event,user_id) references public.events(id,user_id) on delete cascade,
 foreign key(from_card,from_event,user_id) references public.event_board_cards(id,event_id,user_id) on delete cascade,
 foreign key(to_card,to_event,user_id) references public.event_board_cards(id,event_id,user_id) on delete cascade,
 check(not(from_event=to_event and from_card is not distinct from to_card))
);
create unique index if not exists knowledge_links_unique on public.knowledge_links(user_id,from_event,coalesce(from_card,'00000000-0000-0000-0000-000000000000'),to_event,coalesce(to_card,'00000000-0000-0000-0000-000000000000'));
alter table public.knowledge_links enable row level security;
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='knowledge_links' and policyname='knowledge_owner') then
 create policy knowledge_owner on public.knowledge_links for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());end if;
end $$;
grant select,insert,delete on public.knowledge_links to authenticated;
create or replace function public.search_knowledge(search_text text)
returns table(node_id text,event_id uuid,card_id uuid,title text,excerpt text,kind text,start_at timestamptz)
language sql stable security invoker set search_path=public as $$
 select * from (
 select 'event:'||e.id,e.id,null::uuid,e.title,left(concat_ws(' · ',e.description,e.notes,e.location,e.course,e.preparation),700),'event',e.start_at
 from public.events e where length(btrim(search_text)) between 1 and 200 and strpos(lower(concat_ws(' ',e.title,e.description,e.notes,e.location,e.course,e.preparation)),lower(btrim(search_text)))>0
 union all
 select 'card:'||c.id,c.event_id,c.id,coalesce(nullif(c.title,''),c.original_filename,'未命名便签'),left(c.body,700),c.kind,null::timestamptz
 from public.event_board_cards c where length(btrim(search_text)) between 1 and 200 and strpos(lower(concat_ws(' ',c.title,c.body,c.url,c.original_filename)),lower(btrim(search_text)))>0
 ) matches order by 4,1 limit 200;
$$;
revoke all on function public.search_knowledge(text) from public;
grant execute on function public.search_knowledge(text) to authenticated;
commit;
