#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ying_db="ying-test-${RANDOM}-$$"
trap 'docker rm -f "$ying_db" >/dev/null 2>&1 || true' EXIT
docker run --name "$ying_db" -e POSTGRES_PASSWORD=local-test-only -d postgres:17 >/dev/null
for attempt in {1..30}; do
  if docker exec "$ying_db" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < tests/db-bootstrap.sql
docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/001_ying_os.sql
docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < tests/database.sql
docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < tests/board-storage-bootstrap.sql
for attempt in 1 2; do
  docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/002_event_boards.sql
done
docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < tests/event-boards.sql
docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < tests/cron-before.sql
for attempt in 1 2; do
  docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < supabase/cron.sql
  docker exec -i "$ying_db" psql -U postgres -v ON_ERROR_STOP=1 < tests/cron-after.sql
done
