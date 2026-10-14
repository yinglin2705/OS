do $$ begin
 if (select count(*) from cron.job where active and position('ying_worker_url' in command)>0)<>1 then raise exception 'Expected one active YING OS job';end if;
 if (select count(*) from cron.job where position('ying_worker_url' in command)>0 and active and schedule='* * * * *')<>1 then raise exception 'Minute cadence missing';end if;
 if (select count(*) from cron.job)<>3 then raise exception 'Created extra Cron job instead of reusing one';end if;
 if not exists(select 1 from cron.job where jobname='duplicate-ying-cron' and not active) then raise exception 'Duplicate job still active';end if;
 if not exists(select 1 from cron.job where jobname='unrelated-service' and active and schedule='0 12 * * *') then raise exception 'Unrelated task modified';end if;
 if exists(select 1 from cron.job where position('local-test-only-' in command)>0) then raise exception 'Secret literal leaked into Cron command';end if;
end $$;
\echo 'Cron reuse, deduplication, repeatability and secret-reference assertions passed.'
