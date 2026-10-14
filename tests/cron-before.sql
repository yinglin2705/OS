-- Stub only the hosted extension APIs for local repeatability tests.
-- The real pg_cron/pg_net/Vault installation still requires hosted verification.
create schema cron;
create schema vault;
create table cron.job(jobid bigserial primary key,jobname text,schedule text,command text,active boolean default true);
create table vault.secrets(id uuid default gen_random_uuid() primary key,name text,secret text);
create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language plpgsql as $$
declare result bigint; begin insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command) returning jobid into result;return result;end $$;
create function cron.alter_job(job_id bigint,schedule text default null,command text default null,database text default null,username text default null,active boolean default null) returns void language plpgsql as $$
begin update cron.job j set schedule=coalesce(alter_job.schedule,j.schedule),command=coalesce(alter_job.command,j.command),active=coalesce(alter_job.active,j.active) where jobid=job_id;end $$;
insert into vault.secrets(name,secret) values('ying_worker_url','https://test.supabase.co/functions/v1/notification-worker'),('ying_scheduler_secret',repeat('local-test-only-',5));
insert into cron.job(jobname,schedule,command) values
 ('old-ying-cron','0 * * * *','select ''https://test.supabase.co/functions/v1/notification-worker'''),
 ('duplicate-ying-cron','* * * * *','select ''ying_worker_url'''),
 ('unrelated-service','0 12 * * *','select 1');
