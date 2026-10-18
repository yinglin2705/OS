\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000041'),('00000000-0000-4000-8000-000000000042');
insert into public.events(id,user_id,title,status,start_at,preparation) values
('20000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000041','C4D fixture','booked',now()+interval '3 days','Test preparation'),
('20000000-0000-4000-8000-000000000042','00000000-0000-4000-8000-000000000042','Private fixture','planned',null,null);
insert into public.event_board_cards(user_id,event_id,kind,title,image_path) values('00000000-0000-4000-8000-000000000041','20000000-0000-4000-8000-000000000041','image','Private attachment','00000000-0000-4000-8000-000000000041/20000000-0000-4000-8000-000000000041/fixture.png');
insert into public.note_import_batches(id,user_id,course,source_text,source_label,engine,source_hash) values
('40000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000041','C4D','Lesson A raw; Lesson B raw','fixture.txt','rules','fixture');
insert into public.note_import_proposals(user_id,batch_id,action,payload) values
('00000000-0000-4000-8000-000000000041','40000000-0000-4000-8000-000000000041','create',jsonb_build_object('title','Lesson A','course','C4D','lesson_date','2026-10-19','body','Knowledge [[Lesson B]]','tags',jsonb_build_array('C4D'),'event_ids',jsonb_build_array('20000000-0000-4000-8000-000000000041'),'related_titles',jsonb_build_array('Lesson B'),'source_excerpt','Lesson A raw','fingerprint',repeat('a',64))),
('00000000-0000-4000-8000-000000000041','40000000-0000-4000-8000-000000000041','create',jsonb_build_object('title','Lesson B','course','C4D','lesson_date','2026-10-26','body','Steps','tags',jsonb_build_array('C4D'),'event_ids','[]'::jsonb,'related_titles','[]'::jsonb,'source_excerpt','Lesson B raw','fingerprint',repeat('b',64)));
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000041',true);
select public.confirm_note_batch('40000000-0000-4000-8000-000000000041');
select public.confirm_note_batch('40000000-0000-4000-8000-000000000041');
do $$ begin
 if (select count(*) from public.notes)<>2 or (select count(*) from public.note_sources)<>2 then raise exception 'Note batch missing/duplicated';end if;
 if (select count(*) from public.note_event_links)<>1 or (select count(*) from public.note_links)<>1 then raise exception 'Note links missing';end if;
 if (select count(*) from public.search_knowledge('C4D') where kind='class_note')<>2 then raise exception 'Course search failed';end if;
 begin update public.note_import_proposals set payload=payload||'{"body":"rewritten"}' where batch_id='40000000-0000-4000-8000-000000000041';raise exception 'Accepted preview rewritten';exception when raise_exception then if SQLERRM='Accepted preview rewritten' then raise;end if;end;
end $$;
-- A review conflict rolls back the whole batch, including earlier create proposals.
reset role;
insert into public.note_import_batches(id,course,source_text,source_label,engine,source_hash) values('40000000-0000-4000-8000-000000000043','C4D','rollback fixture','fixture','rules','rollback');
insert into public.note_import_proposals(batch_id,action,payload) values
('40000000-0000-4000-8000-000000000043','create','{"title":"Must roll back","course":"C4D","body":"fixture"}'),
('40000000-0000-4000-8000-000000000043','review','{"title":"Unresolved","course":"C4D","body":"fixture"}');
set local role authenticated;
do $$ begin
 begin perform public.confirm_note_batch('40000000-0000-4000-8000-000000000043');raise exception 'Review unexpectedly committed';exception when raise_exception then if SQLERRM='Review unexpectedly committed' then raise;end if;end;
 if exists(select 1 from public.notes where title='Must roll back') then raise exception 'Partial import survived rollback';end if;
 if exists(select 1 from public.note_import_proposals where batch_id='40000000-0000-4000-8000-000000000043' and state='accepted') then raise exception 'Partial preview accepted';end if;
end $$;
select public.delete_note_record('batch','40000000-0000-4000-8000-000000000043');
select public.trash_event('20000000-0000-4000-8000-000000000041',false);
do $$ begin
 if exists(select 1 from public.events where id='20000000-0000-4000-8000-000000000041' and (deleted_at is null or status<>'cancelled')) then raise exception 'Trash failed';end if;
 if exists(select 1 from public.reminder_jobs where state in ('proposed','approved')) then raise exception 'Trashed reminder active';end if;
 if (select count(*) from public.notes)<>2 then raise exception 'Trashing event lost notes';end if;
end $$;
select public.trash_event('20000000-0000-4000-8000-000000000041',true);
do $$ begin if (select status from public.events where id='20000000-0000-4000-8000-000000000041')<>'booked' then raise exception 'Restore status lost';end if;end $$;
select public.trash_note((select id from public.notes where title='Lesson A'),false);
do $$ begin if (select count(*) from public.search_knowledge('Knowledge') where kind='class_note')<>0 then raise exception 'Trashed note searched';end if;end $$;
select public.trash_note((select id from public.notes where title='Lesson A'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000042',true);
do $$ begin
 if exists(select 1 from public.notes) or exists(select 1 from public.note_sources) then raise exception 'Note RLS leak';end if;
 begin perform public.trash_event('20000000-0000-4000-8000-000000000041',false);raise exception 'Foreign event trashed';exception when raise_exception then if SQLERRM='Foreign event trashed' then raise;end if;end;
 begin perform public.confirm_note_batch('40000000-0000-4000-8000-000000000041');raise exception 'Foreign batch confirmed';exception when raise_exception then if SQLERRM='Foreign batch confirmed' then raise;end if;end;
end $$;
reset role;
-- Deleted delivery keys survive as hashes so clearing history cannot re-enqueue the same briefing.
insert into public.telegram_connections(user_id,chat_id) values('00000000-0000-4000-8000-000000000041',9000041);
update public.users set timezone='UTC' where id='00000000-0000-4000-8000-000000000041';
update public.scheduled_briefings set enabled=false;
update public.scheduled_briefings set enabled=true,local_time=date_trunc('minute',now())::time where user_id='00000000-0000-4000-8000-000000000041' and kind='morning';
select public.enqueue_due();
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000041',true);
select public.delete_owned_record('delivery',(select id from public.notification_deliveries where kind='morning' limit 1));
reset role;
select public.enqueue_due();
do $$ begin if exists(select 1 from public.notification_deliveries where kind='morning') then raise exception 'Cleared delivery re-enqueued';end if;end $$;
set local role authenticated;
select public.trash_event('20000000-0000-4000-8000-000000000041',false);
select public.purge_event('20000000-0000-4000-8000-000000000041');
do $$ begin
 if (select count(*) from public.notes)<>2 then raise exception 'Purging event lost independent notes';end if;
 if exists(select 1 from public.note_event_links) then raise exception 'Dead event link retained';end if;
 if (select count(*) from public.file_deletion_jobs)<>1 then raise exception 'Attachment cleanup not queued';end if;
end $$;
select public.trash_note((select id from public.notes where title='Lesson A'),false);
select public.delete_note_record('note',(select id from public.notes where title='Lesson A'));
do $$ begin if exists(select 1 from public.note_sources where original_text='Lesson A raw') then raise exception 'Note sources retained after purge';end if;end $$;
reset role;
delete from auth.users where id='00000000-0000-4000-8000-000000000041';
do $$ begin if exists(select 1 from public.notification_tombstones) or exists(select 1 from public.file_deletion_jobs) then raise exception 'Account cascade incomplete';end if;end $$;
rollback;
