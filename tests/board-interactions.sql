\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000031'),('00000000-0000-4000-8000-000000000032');
insert into public.events(id,user_id,title) values
('20000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000031','Board A'),
('20000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000032','Private board B');
insert into public.event_board_cards(id,user_id,event_id,kind,title) values
('30000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000031','20000000-0000-4000-8000-000000000031','note','A'),
('30000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000031','20000000-0000-4000-8000-000000000031','note','B'),
('30000000-0000-4000-8000-000000000033','00000000-0000-4000-8000-000000000032','20000000-0000-4000-8000-000000000032','note','Private');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000031',true);
select public.connect_board_cards('30000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000032');
select public.connect_board_cards('30000000-0000-4000-8000-000000000032','30000000-0000-4000-8000-000000000031');
do $$ begin
 if (select count(*) from public.event_board_edges)<>1 then raise exception 'Reverse duplicate created';end if;
 begin perform public.connect_board_cards('30000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000033');raise exception 'Foreign card connected';
 exception when raise_exception then if SQLERRM='Foreign card connected' then raise;end if;end;
 begin perform public.connect_board_cards('30000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000031');raise exception 'Self connected';
 exception when raise_exception then if SQLERRM='Self connected' then raise;end if;end;
end $$;
select public.create_linked_board_note('30000000-0000-4000-8000-000000000031','New note','Content',700,350,'pink');
do $$ begin
 if (select count(*) from public.event_board_cards)<>3 or (select count(*) from public.event_board_edges)<>2 then raise exception 'Atomic linked creation failed';end if;
 begin perform public.create_linked_board_note('30000000-0000-4000-8000-000000000031','Bad width','Content',90000,350,'pink');raise exception 'Invalid position accepted';
 exception when check_violation then null;end;
 if (select count(*) from public.event_board_cards)<>3 then raise exception 'Failed creation left orphan';end if;
end $$;
insert into public.board_highlights(event_id,card_id,page,color,points) values
('20000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000031',1,'yellow','[[0.2,0.3],[0.8,0.3]]'),
('20000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000031',2,'blue','[[0.1,0.5],[0.7,0.5]]');
update public.event_board_cards set display_width=600,pdf_page=2 where id='30000000-0000-4000-8000-000000000031';
do $$ begin
 if (select count(*) from public.board_highlights where page=1)<>1 or (select count(*) from public.board_highlights where page=2)<>1 then raise exception 'Page annotations mixed';end if;
 begin insert into public.board_highlights(event_id,card_id,points) values('20000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000031','[[8,0]]');raise exception 'Bad coordinates accepted';
 exception when check_violation then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000032',true);
do $$ begin
 if exists(select 1 from public.board_highlights) then raise exception 'Highlights leaked';end if;
 begin insert into public.board_highlights(event_id,card_id,points) values('20000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000031','[[0,0]]');raise exception 'Foreign highlight accepted';
 exception when foreign_key_violation then null;end;
end $$;
set local role anon;
do $$ begin
 if has_function_privilege(current_user,'public.connect_board_cards(uuid,uuid)','execute') or has_function_privilege(current_user,'public.create_linked_board_note(uuid,text,text,integer,integer,text)','execute') then raise exception 'Anonymous mutation RPC exposed';end if;
 if exists(select 1 from public.board_highlights) then raise exception 'Anonymous highlight leaked';end if;
end $$;
reset role;
delete from public.events where id='20000000-0000-4000-8000-000000000031';
do $$ begin if exists(select 1 from public.board_highlights) then raise exception 'Highlights did not cascade';end if;end $$;
rollback;
