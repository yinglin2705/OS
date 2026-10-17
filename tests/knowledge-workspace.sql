\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000021'),('00000000-0000-4000-8000-000000000022');
insert into public.events(id,user_id,title,notes) values
('20000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000021','Research test','百分号 % 原始备注'),
('20000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000021','Other project',''),
('20000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000022','Secret research','');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000021',true);
insert into public.event_board_cards(id,event_id,kind,title,body,image_path,original_filename) values
('30000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000021','pdf','PDF reading','中文笔记 searchable','00000000-0000-4000-8000-000000000021/20000000-0000-4000-8000-000000000021/file.pdf','reference.pdf');
insert into public.knowledge_links(from_event,from_card,to_event) values('20000000-0000-4000-8000-000000000021','30000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000022');
do $$ begin
 if (select count(*) from public.search_knowledge('research'))<>1 then raise exception 'Search leaked or missed event';end if;
 if (select count(*) from public.search_knowledge('中文'))<>1 then raise exception 'Chinese text search failed';end if;
 if (select count(*) from public.search_knowledge('reference.pdf'))<>1 then raise exception 'Filename search failed';end if;
 if (select count(*) from public.search_knowledge('%'))<>1 then raise exception 'Search wildcard was interpreted';end if;
 if exists(select 1 from public.search_knowledge('  ')) then raise exception 'Blank search returned data';end if;
 begin
 insert into public.knowledge_links(from_event,to_event) values('20000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000023');
 raise exception 'Foreign event linked';exception when foreign_key_violation then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000022',true);
do $$ begin
 if exists(select 1 from public.search_knowledge('中文')) or exists(select 1 from public.knowledge_links) then raise exception 'Knowledge RLS leak';end if;
end $$;
set local role anon;
do $$ begin
 if has_function_privilege(current_user,'public.search_knowledge(text)','execute') then raise exception 'Anonymous search allowed';end if;
end $$;
reset role;
delete from public.events where id='20000000-0000-4000-8000-000000000021';
do $$ begin if exists(select 1 from public.knowledge_links) then raise exception 'Knowledge cascade failed';end if;end $$;
rollback;
