begin;
create or replace function public.set_event_status(target uuid,expected_version integer,new_status text) returns uuid
language plpgsql security definer set search_path=public as $$
declare e public.events;begin
 if auth.uid() is null then raise exception 'Authentication required';end if;
 if new_status is null or new_status not in ('confirmed','booked','applied','planned','considering','waiting','cancelled','completed') then raise exception 'Invalid status';end if;
 select * into e from public.events where id=target and user_id=auth.uid() and deleted_at is null for update;
 if not found or e.version is distinct from expected_version then raise exception 'Event changed or unavailable';end if;
 if e.status=new_status then return e.id;end if;
 update public.events set status=new_status where id=e.id;
 insert into public.event_sources(user_id,event_id,source_type,notes,original_record) values(auth.uid(),e.id,'manual_status','用户在活动详情直接修改状态',jsonb_build_object('old_status',e.status,'new_status',new_status));
 return e.id;
end $$;
revoke all on function public.set_event_status(uuid,integer,text) from public,anon;
grant execute on function public.set_event_status(uuid,integer,text) to authenticated;
commit;
