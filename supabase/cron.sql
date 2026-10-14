-- Requires pg_cron, pg_net, Vault and the two named Vault secrets.
-- The automated deployment command creates missing extensions and securely syncs Vault.
-- Safe to repeat. Consolidates only jobs targeting this YING OS worker.
begin;
select pg_advisory_xact_lock(hashtext('ying-os-notification-cron'));
do $$
declare
 worker_url text;
 candidate bigint;
 command_text text;
 secret_count integer;
 secret_length integer;
begin
 if to_regclass('cron.job') is null or to_regclass('vault.decrypted_secrets') is null then
  raise exception 'Cron and Vault must be enabled before notification scheduling';
 end if;
 select count(*),max(decrypted_secret) into secret_count,worker_url from vault.decrypted_secrets where name='ying_worker_url';
 if secret_count<>1 or worker_url is null or worker_url !~ '^https://[^/]+/functions/v1/notification-worker$' then
  raise exception 'Exactly one valid ying_worker_url Vault entry is required';
 end if;
 select count(*),min(length(decrypted_secret)) into secret_count,secret_length from vault.decrypted_secrets where name='ying_scheduler_secret';
 if secret_count<>1 or secret_length is null or secret_length<32 then raise exception 'Exactly one valid ying_scheduler_secret Vault entry is required'; end if;
 command_text=$job$
 select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='ying_worker_url'),
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='ying_scheduler_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 60000
 );
 $job$;
 select jobid into candidate from cron.job
 where jobname='ying-os-every-minute' or position(worker_url in command)>0 or position('ying_worker_url' in command)>0
 order by (jobname='ying-os-every-minute') desc,jobid limit 1;
 if candidate is null then
  perform cron.schedule('ying-os-every-minute','* * * * *',command_text);
 else
  perform cron.alter_job(candidate,schedule:='* * * * *',command:=command_text,active:=true);
  perform cron.alter_job(jobid,active:=false) from cron.job
   where jobid<>candidate and active and (jobname='ying-os-every-minute' or position(worker_url in command)>0 or position('ying_worker_url' in command)>0);
 end if;
end $$;
commit;
