-- Run after enabling Cron, pg_net and Vault in the Supabase dashboard.
-- Store these via Vault UI: ying_worker_url (https://<project>.supabase.co/functions/v1/notification-worker)
-- and ying_scheduler_secret (same value as Edge Function SCHEDULER_SECRET).
-- Do not commit secret literals into SQL or source control.
select cron.schedule('ying-os-every-minute','* * * * *', $$
 select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='ying_worker_url' limit 1),
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='ying_scheduler_secret' limit 1)),
  body := '{}'::jsonb,
  timeout_milliseconds := 60000
 );
$$);
