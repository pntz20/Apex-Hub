-- Split from the original 0001_init.sql during the 22 Sep 2026 rebuild.
-- Postgres will not use an enum value added by ALTER TYPE ... ADD VALUE in the
-- same transaction, so the file is cut after each ADD VALUE group. Run a, b, c
-- in order, each as its own statement batch. Content is otherwise unchanged.

-- One edit rather than forty: every policy already routes through this, so
-- widening it grants the new privilege level across every table at once.
create or replace function auth_is_admin()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$
  select auth_role() in ('admin', 'super_admin');
$fn$;


-- ===========================================================================
-- CLIENT ONBOARDING BOARD
--
-- Six columns, of which only two are opinions. new_signup, onboarding_form and
-- kickoff_form are facts about which form exists; launch_ready is a fact about
-- the checklist. Only waiting_on_team and waiting_on_client are set by a person,
-- which is why this is not a drag-anywhere board — moving a card by hand would
-- make it disagree with the filing cabinet.
--
-- The checklist lives in onboarding_step_template rather than in code, because
-- the team will reword and reorder it, and because "launch ready means every
-- active step is done" is a rule the database can only apply if it knows the
-- steps.
-- ===========================================================================

create type onboarding_status as enum (
  'new_signup', 'onboarding_form', 'kickoff_form',
  'waiting_on_team', 'waiting_on_client', 'launch_ready'
);

alter table client_groups
  add column onboarding_status onboarding_status not null default 'new_signup',
  add column csm_user_id uuid references user_profiles (id) on delete set null,
  -- Both come from the ADM Client Onboarding sub-account's calendars, not from
  -- anything typed here.
  add column onboarding_call_at timestamptz,
  add column launch_call_at timestamptz,
  add column onboarding_added_at timestamptz not null default now(),
  -- Compared against the newest form, so an arriving form can overtake a manual
  -- hold but a stale form cannot.
  add column status_set_manually_at timestamptz,
  add column status_set_by uuid references user_profiles (id) on delete set null;

create index client_groups_onboarding_status_idx on client_groups (onboarding_status);
create index client_groups_csm_idx on client_groups (csm_user_id);

create table onboarding_step_template (
  step_key    text primary key,
  group_key   text not null,
  group_label text not null,
  label       text not null,
  -- Intended to be done by a script. Recorded so the board can admit which
  -- steps are still waiting on automation that does not exist, rather than
  -- quietly presenting them as ordinary manual work.
  automated   boolean not null default false,
  sort_order  integer not null,
  is_active   boolean not null default true
);

-- One row per step a client has progressed. Absent means not started.
create table onboarding_step_state (
  client_group_id uuid not null references client_groups (id) on delete cascade,
  step_key        text not null,
  done_at         timestamptz,
  done_by         uuid references user_profiles (id) on delete set null,
  note            text,
  -- Where the ads copy step puts what the client reviews in their portal.
  asset_url       text,
  updated_at      timestamptz not null default now(),
  primary key (client_group_id, step_key)
);

create index onboarding_step_state_group_idx on onboarding_step_state (client_group_id);

-- Append-only. A status that changed with no record of who changed it is the
-- thing this board exists to stop.
create table onboarding_activity (
  id              uuid primary key default gen_random_uuid(),
  client_group_id uuid not null references client_groups (id) on delete cascade,
  kind            text not null,
  detail          text not null,
  actor_user_id   uuid references user_profiles (id) on delete set null,
  actor_name      text,
  created_at      timestamptz not null default now()
);

create index onboarding_activity_group_idx
  on onboarding_activity (client_group_id, created_at desc);

alter table onboarding_step_template enable row level security;
alter table onboarding_step_state    enable row level security;
alter table onboarding_activity      enable row level security;

create policy admin_all on onboarding_step_template for all using (auth_is_admin()) with check (auth_is_admin());
create policy read_all  on onboarding_step_template for select using (true);
create policy admin_all on onboarding_step_state    for all using (auth_is_admin()) with check (auth_is_admin());
create policy admin_all on onboarding_activity      for all using (auth_is_admin()) with check (auth_is_admin());

-- Precedence, highest first: every step done beats a manual hold, because once
-- the work is finished "waiting on somebody" is no longer true; a hold beats the
-- forms, but only while it is newer than the newest form.
create or replace function onboarding_status_for(p_group uuid)
returns onboarding_status
language plpgsql stable set search_path = public, pg_temp
as $fn$
declare
  v_active integer; v_done integer;
  v_latest_form timestamptz; v_manual_at timestamptz;
  v_manual onboarding_status; v_form_stage onboarding_status;
begin
  select count(*) into v_active from onboarding_step_template where is_active;

  select count(*) into v_done
  from onboarding_step_state s
  join onboarding_step_template t on t.step_key = s.step_key and t.is_active
  where s.client_group_id = p_group and s.done_at is not null;

  if v_active > 0 and v_done >= v_active then return 'launch_ready'; end if;

  select max(submitted_at) into v_latest_form
  from form_submissions
  where client_group_id = p_group and not is_test
    and form_key in ('new-client','client-onboarding','client-onboarding-legacy','kick-off');

  select onboarding_status, status_set_manually_at into v_manual, v_manual_at
  from client_groups where id = p_group;

  if v_manual in ('waiting_on_team','waiting_on_client')
     and v_manual_at is not null
     and (v_latest_form is null or v_manual_at > v_latest_form) then
    return v_manual;
  end if;

  select case
           when bool_or(form_key = 'kick-off') then 'kickoff_form'
           when bool_or(form_key in ('client-onboarding','client-onboarding-legacy')) then 'onboarding_form'
           else 'new_signup'
         end::onboarding_status
    into v_form_stage
  from form_submissions where client_group_id = p_group and not is_test;

  return coalesce(v_form_stage, 'new_signup');
end;
$fn$;

create or replace function refresh_onboarding_status(p_group uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $fn$
declare v_now onboarding_status; v_next onboarding_status;
begin
  if p_group is null then return; end if;
  select onboarding_status into v_now from client_groups where id = p_group;
  v_next := onboarding_status_for(p_group);
  if v_next is distinct from v_now then
    update client_groups set onboarding_status = v_next where id = p_group;
    insert into onboarding_activity (client_group_id, kind, detail, actor_name)
    values (p_group, 'status_changed',
            format('Moved from %s to %s', v_now, v_next), 'Automatic');
  end if;
end;
$fn$;

create or replace function tg_refresh_onboarding_status()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $fn$
begin
  perform refresh_onboarding_status(coalesce(new.client_group_id, old.client_group_id));
  return null;
end;
$fn$;

create trigger form_submissions_refresh_onboarding
  after insert or update or delete on form_submissions
  for each row execute function tg_refresh_onboarding_status();

create trigger onboarding_step_state_refresh_status
  after insert or update or delete on onboarding_step_state
  for each row execute function tg_refresh_onboarding_status();

insert into onboarding_step_template
  (step_key, group_key, group_label, label, automated, sort_order) values
  ('ghl_subaccount', 'ghl', 'GHL Set Up', 'Create sub account', true, 10),
  ('ghl_custom_values', 'ghl', 'GHL Set Up', 'Fill custom values', true, 20),
  ('ghl_subdomain', 'ghl', 'GHL Set Up', 'Create and connect subdomain', true, 30),
  ('ghl_phone', 'ghl', 'GHL Set Up', 'Purchase and configure phone number', false, 40),
  ('ghl_a2p', 'ghl', 'GHL Set Up', 'Submit A2P', false, 50),
  ('ghl_automation', 'ghl', 'GHL Set Up', 'Configure the automation', false, 60),
  ('hp_integrate', 'hp', 'HotProspector Set Up', 'Integrate sub account', false, 110),
  ('hp_phone', 'hp', 'HotProspector Set Up', 'Buy phone number', false, 120),
  ('hp_scripts', 'hp', 'HotProspector Set Up', 'Script templates configuration', false, 130),
  ('hp_business_reg', 'hp', 'HotProspector Set Up', 'Submit business registration', false, 140),
  ('hp_custom_values', 'hp', 'HotProspector Set Up', 'Custom values', false, 150),
  ('hp_webhook', 'hp', 'HotProspector Set Up', 'Global webhook integration', false, 160),
  ('ads_pixel_config', 'ads', 'Ads Set Up', 'Data and pixel configuration', false, 210),
  ('ads_buildout', 'ads', 'Ads Set Up', 'Facebook ads buildout', false, 220),
  ('ads_pixel_code', 'ads', 'Ads Set Up', 'Add pixel code', false, 230),
  ('ads_copy', 'ads', 'Ads Set Up', 'Ads copy creation', false, 240);


-- ===========================================================================
-- PROVISIONING
--
-- Every attempt to build a sub-account from the onboarding form, successful or
-- not, so provisioning can fail without losing anything. The submission is
-- saved first and this records what happened next: a refused API call becomes a
-- retry rather than a practice filling the form twice.
--
-- Append-only per attempt. The second try does not overwrite the first, because
-- "it worked on the third go" and "it worked" are different facts and only one
-- of them should send somebody to fix the cause.
--
-- crm_location_id is what makes a retry safe. With an id, the retry configures
-- the account that already exists; without it, an agency ends up with two
-- sub-accounts for one practice and nobody notices for a month.
-- ===========================================================================

create table provisioning_runs (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid references form_submissions (id) on delete set null,
  client_group_id   uuid references client_groups (id) on delete set null,
  clinic_name       text not null,
  snapshot_id       text not null,
  -- 'created' | 'values_written' | 'partial' | 'failed'
  status            text not null,
  crm_location_id   text,
  values_written    text[] not null default '{}',
  values_missing    text[] not null default '{}',
  values_failed     jsonb  not null default '[]'::jsonb,
  error             text,
  -- True when the refusal looked like authorisation rather than data, which is
  -- the difference between "re-authorise the app" and "fix the form".
  scope_problem     boolean not null default false,
  started_by        uuid references user_profiles (id) on delete set null,
  created_at        timestamptz not null default now()
);

create index provisioning_runs_submission_idx on provisioning_runs (submission_id);
create index provisioning_runs_group_idx on provisioning_runs (client_group_id);
create index provisioning_runs_created_idx on provisioning_runs (created_at desc);

alter table provisioning_runs enable row level security;
create policy admin_all on provisioning_runs
  for all using (auth_is_admin()) with check (auth_is_admin());

-- Which credential the attempt went out under. Without it, "401 from
-- /locations/" cannot be told apart from "the private token is not accepted for
-- this endpoint", and those two have opposite fixes.
alter table provisioning_runs add column auth_kind text;

-- Joshua's B2B pipeline has a Nurture stage — a lead parked deliberately, which
-- is neither lost nor in progress. Without it the sync mapped Nurture to 'new'
-- and reported held leads as fresh ones.
alter type deal_stage add value if not exists 'nurture';
