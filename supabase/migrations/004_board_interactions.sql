begin;
select pg_advisory_xact_lock(hashtext('ying-os-board-interactions-v1'));
alter table public.event_board_cards drop constraint if exists event_board_cards_x_check;
alter table public.event_board_cards drop constraint if exists event_board_cards_y_check;
alter table public.event_board_cards drop constraint if exists board_x_v2;
alter table public.event_board_cards drop constraint if exists board_y_v2;
alter table public.event_board_cards add constraint board_x_v2 check(x between 0 and 20000);
alter table public.event_board_cards add constraint board_y_v2 check(y between 0 and 20000);

do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='event_board_cards' and column_name='display_width') then
 alter table public.event_board_cards add column display_width integer not null default 270 check(display_width between 200 and 1000);
 update public.event_board_cards set display_width=case kind when 'pdf' then 540 when 'image' then 340 else 270 end;
 end if;
end $$;
alter table public.event_board_cards add column if not exists pdf_page integer not null default 1 check(pdf_page between 1 and 10000);
create or replace function public.valid_highlight_points(p jsonb) returns boolean language plpgsql immutable set search_path=public as $$
declare v jsonb;begin
 if jsonb_typeof(p)<>'array' or jsonb_array_length(p) not between 1 and 512 then return false;end if;
 for v in select value from jsonb_array_elements(p) loop
 if jsonb_typeof(v)<>'array' or jsonb_array_length(v)<>2 or jsonb_typeof(v->0)<>'number' or jsonb_typeof(v->1)<>'number' then return false;end if;
 if (v->>0)::numeric not between 0 and 1 or (v->>1)::numeric not between 0 and 1 then return false;end if;
 end loop;return true;
 exception when others then return false;end $$;
create table if not exists public.board_highlights(
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid(),event_id uuid not null,card_id uuid not null,
 page integer not null default 0 check(page between 0 and 10000),
 color text not null default 'yellow' check(color in ('yellow','pink','green','blue')),
 points jsonb not null check(public.valid_highlight_points(points)),
 created_at timestamptz not null default now(),
 foreign key(card_id,event_id,user_id) references public.event_board_cards(id,event_id,user_id) on delete cascade
);
alter table public.board_highlights enable row level security;
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='board_highlights' and policyname='highlight_owner') then
 create policy highlight_owner on public.board_highlights for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());end if;
end $$;
grant select,insert,delete on public.board_highlights to authenticated;
create or replace function public.connect_board_cards(source_card uuid,target_card uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare a public.event_board_cards;b public.event_board_cards;result uuid;begin
 select * into a from public.event_board_cards where id=source_card and user_id=auth.uid();
 if not found then raise exception 'Source unavailable';end if;
 select * into b from public.event_board_cards where id=target_card and user_id=auth.uid();
 if not found or a.event_id<>b.event_id or a.id=b.id then raise exception 'Target unavailable';end if;
 perform pg_advisory_xact_lock(hashtext(least(a.id,b.id)::text||greatest(a.id,b.id)::text));
 select id into result from public.event_board_edges where user_id=auth.uid() and event_id=a.event_id and ((from_card=a.id and to_card=b.id) or (from_card=b.id and to_card=a.id)) order by id limit 1;
 if result is not null then return result;end if;
 insert into public.event_board_edges(user_id,event_id,from_card,to_card) values(auth.uid(),a.event_id,least(a.id,b.id),greatest(a.id,b.id)) returning id into result;
 return result;end $$;
create or replace function public.create_linked_board_note(source_card uuid,note_title text,note_body text,position_x integer,position_y integer,note_color text default 'yellow') returns uuid
language plpgsql security definer set search_path=public as $$
declare source public.event_board_cards;result uuid;begin
 select * into source from public.event_board_cards where id=source_card and user_id=auth.uid();
 if not found then raise exception 'Source unavailable';end if;
 if length(btrim(coalesce(note_title,'')))=0 and length(btrim(coalesce(note_body,'')))=0 then raise exception 'Note required';end if;
 insert into public.event_board_cards(user_id,event_id,kind,title,body,x,y,color)
 values(auth.uid(),source.event_id,'note',coalesce(note_title,''),coalesce(note_body,''),position_x,position_y,note_color) returning id into result;
 perform public.connect_board_cards(source_card,result);return result;end $$;
revoke all on function public.connect_board_cards(uuid,uuid) from public;
revoke all on function public.create_linked_board_note(uuid,text,text,integer,integer,text) from public;
grant execute on function public.connect_board_cards(uuid,uuid) to authenticated;
grant execute on function public.create_linked_board_note(uuid,text,text,integer,integer,text) to authenticated;
commit;
