-- Added in the 22 Sep 2026 rebuild. The old live database had these columns but
-- no migration in the repo created them (drift, found by diffing against
-- src/types/database.generated.ts). Safe to re-run.

alter table stat_sheet_appointments
  add column if not exists campaign_external_id text,
  add column if not exists adset_external_id text,
  add column if not exists adset_name text,
  add column if not exists ad_external_id text,
  add column if not exists ad_name text,
  add column if not exists outcome_notes text,
  add column if not exists treatment_value_cents bigint;
alter table callcentre_requests add column if not exists authenticated_by text;
