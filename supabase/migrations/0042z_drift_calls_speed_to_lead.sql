-- Added in the 22 Sep 2026 rebuild. The old live database had these columns but
-- no migration in the repo created them (drift, found by diffing against
-- src/types/database.generated.ts). Safe to re-run.

alter table calls add column if not exists lead_created_at timestamptz;
alter table calls add column if not exists speed_to_lead_minutes numeric;
