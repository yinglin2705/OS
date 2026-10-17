\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000011'),('00000000-0000-4000-8000-000000000012');
insert into public.events(id,user_id,title) values
('20000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000011','Board A'),
('20000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000012','Board B');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',true);
insert into public.event_board_cards(id,event_id,kind,body) values
('30000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000011','note','Private note'),
('30000000-0000-4000-8000-000000000012','20000000-0000-4000-8000-000000000011','note','Related note');
insert into public.event_board_edges(event_id,from_card,to_card) values('20000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000012');
insert into storage.objects(bucket_id,name) values('event-board','00000000-0000-4000-8000-000000000011/20000000-0000-4000-8000-000000000011/test.png');
update public.event_board_cards set x=400,y=200 where id='30000000-0000-4000-8000-000000000011';
do $$ begin
 if (select x from public.event_board_cards where id='30000000-0000-4000-8000-000000000011')<>400 then raise exception 'Position not persisted';end if;
 begin
 insert into public.event_board_cards(event_id,kind) values('20000000-0000-4000-8000-000000000012','note');
 raise exception 'Cross-owner event accepted';
 exception when foreign_key_violation then null;end;
 begin
 insert into public.event_board_cards(event_id,kind,url) values('20000000-0000-4000-8000-000000000011','link','javascript:alert(1)');
 raise exception 'Unsafe URL accepted';
 exception when check_violation then null;end;
 begin
 insert into storage.objects(bucket_id,name) values('event-board','00000000-0000-4000-8000-000000000011/20000000-0000-4000-8000-000000000012/test.png');
 raise exception 'Foreign event storage path accepted';
 exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',true);
do $$ begin
 if exists(select 1 from public.event_board_cards) or exists(select 1 from public.event_board_edges) or exists(select 1 from storage.objects) then raise exception 'Private board or image leaked';end if;
 begin
 insert into public.event_board_cards(event_id,user_id,kind) values('20000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000011','note');
 raise exception 'Forged owner accepted';
 exception when insufficient_privilege then null;end;
end $$;
set local role anon;
do $$ begin
 if exists(select 1 from public.event_board_cards) or exists(select 1 from public.event_board_edges) or exists(select 1 from storage.objects) then raise exception 'Anonymous board access';end if;
end $$;
reset role;
delete from public.events where id='20000000-0000-4000-8000-000000000011';
do $$ begin
 if exists(select 1 from public.event_board_cards) or exists(select 1 from public.event_board_edges) then raise exception 'Cascade failed';end if;
 if (select public from storage.buckets where id='event-board')<>false then raise exception 'Public bucket';end if;
end $$;
rollback;
