\set ON_ERROR_STOP on
begin;
do $$ begin
 if ('2026-07-14 06:00Z'::timestamptz at time zone 'Europe/London')::time <> '07:00'::time then raise exception 'BST conversion failed'; end if;
 if ('2026-10-25 07:00Z'::timestamptz at time zone 'Europe/London')::time <> '07:00'::time then raise exception 'GMT conversion failed'; end if;
end $$;
insert into auth.users(id) values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.change_proposals(id,user_id,payload,source) values
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',jsonb_build_object('title','C4D Group A','status','booked','start_at',now()+interval '10 days','end_at',now()+interval '10 days 2 hours','deadline_at',now()+interval '12 days','preparation','核实安全鞋和会员要求'),'{"source_type":"excel","url":"https://ucl.ac.uk/source"}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select public.confirm_proposal('10000000-0000-4000-8000-000000000001',true);
do $$ begin
 if (select count(*) from public.events)<>1 then raise exception 'Confirmation failed'; end if;
 if (select count(*) from public.event_sources)<>1 then raise exception 'Source missing'; end if;
 if (select count(*) from public.reminder_jobs)<>4 then raise exception 'Preparation jobs missing'; end if;
 if exists(select 1 from public.reminder_jobs where state<>'proposed') then raise exception 'Reminder auto-approved'; end if;
 if has_function_privilege(current_user,'public.consume_link(text,bigint)','execute') then raise exception 'Client can consume code'; end if;
 if has_table_privilege(current_user,'public.events','insert') then raise exception 'Client bypasses proposals'; end if;
 begin perform public.confirm_proposal('10000000-0000-4000-8000-000000000001',true); raise exception 'Accepted twice'; exception when raise_exception then if SQLERRM='Accepted twice' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ begin
 if (select count(*) from public.events)<>0 then raise exception 'RLS leaked events'; end if;
 if (select count(*) from public.event_sources)<>0 then raise exception 'RLS leaked sources'; end if;
 if (select count(*) from public.event_status_history)<>0 then raise exception 'RLS leaked history'; end if;
 begin perform public.confirm_proposal('10000000-0000-4000-8000-000000000001',true); raise exception 'Cross-user approval'; exception when raise_exception then if SQLERRM='Cross-user approval' then raise; end if; end;
end $$;
reset role;
insert into public.telegram_link_codes values(encode(extensions.digest('YING-AAAAAAAAAAAAAAAAAAAAAAAA','sha256'),'hex'),'00000000-0000-4000-8000-000000000001',now()+interval '10 minutes',null);
select public.consume_link('YING-AAAAAAAAAAAAAAAAAAAAAAAA',123456);
do $$ begin
 if public.consume_link('YING-AAAAAAAAAAAAAAAAAAAAAAAA',987654) is not null then raise exception 'Code reused'; end if;
 if (select chat_id from public.telegram_connections)<>123456 then raise exception 'Wrong chat'; end if;
end $$;
update public.users set timezone='UTC',quiet_start=null,quiet_end=null where id='00000000-0000-4000-8000-000000000001';
update public.scheduled_briefings set local_time=date_trunc('minute',now())::time where user_id='00000000-0000-4000-8000-000000000001' and kind='morning';
select public.enqueue_due();
select public.enqueue_due();
do $$ begin
 if (select count(*) from public.notification_deliveries where kind='morning')<>1 then raise exception 'Duplicate briefing'; end if;
 if (select count(*) from public.notification_deliveries where kind='preparation')<>0 then raise exception 'Unapproved reminder sent'; end if;
end $$;
select count(*) from public.claim_deliveries();
do $$ begin if (select count(*) from public.claim_deliveries())<>0 then raise exception 'Duplicate claim'; end if; end $$;
update public.notification_deliveries set lease_until=now()-interval '1 minute';
select count(*) from public.claim_deliveries();
do $$ begin if exists(select 1 from public.notification_deliveries where state='sending') then raise exception 'Expired lease not reconciled'; end if; end $$;
-- Version checks reject stale proposals.
insert into public.change_proposals(id,user_id,event_id,expected_version,payload,source)
select '10000000-0000-4000-8000-000000000002',user_id,id,version-1,'{"status":"cancelled"}','{"source_type":"conversation"}' from public.events;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$ begin
 begin perform public.confirm_proposal('10000000-0000-4000-8000-000000000002',true); raise exception 'Stale proposal accepted'; exception when raise_exception then if SQLERRM='Stale proposal accepted' then raise; end if; end;
end $$;
reset role;
-- Update must preserve delivery history and disable old reminders.
update public.events set status='cancelled';
do $$ begin if exists(select 1 from public.reminder_jobs where state='approved' or state='proposed') then raise exception 'Cancelled event reminders active'; end if; end $$;
rollback;
\echo 'Database integration assertions passed (transaction rolled back).'
