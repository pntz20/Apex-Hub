-- Split from the original 0001_init.sql during the 22 Sep 2026 rebuild.
-- Postgres will not use an enum value added by ALTER TYPE ... ADD VALUE in the
-- same transaction, so the file is cut after each ADD VALUE group. Run a, b, c
-- in order, each as its own statement batch. Content is otherwise unchanged.

-- ===========================================================================
-- WHERE A B2B LEAD CAME FROM
--
-- About 10% of the client base refers somebody each month, known because two
-- people were asked. Referrals and word-of-mouth searches are most of the new
-- business while the ads are off, and none of it was measured.
--
-- A referral is invisible to every automatic signal: no utm, no ad id, and
-- GoHighLevel's own source field says nothing useful about one. The tag a human
-- put on the contact is the only record that exists, which is why tags are
-- stored verbatim as well as classified — the classification is a guess over
-- them, the tags are the fact.
--
-- 'origin' rather than reusing 'source': that column already holds GoHighLevel's
-- free-text field, and the two disagree often enough that collapsing them would
-- lose the disagreement.
-- ===========================================================================

create type lead_origin as enum ('referral', 'organic', 'paid', 'outbound', 'unknown');

alter table deals
  add column tags text[] not null default '{}',
  add column origin lead_origin not null default 'unknown';

create index deals_origin_idx on deals (origin);
create index deals_tags_idx on deals using gin (tags);

-- ===========================================================================
-- PRACTICE-NAME MATCHING
--
-- The rule used during the tracker import dropped everything from the first
-- bracket onward. Right for the asides people type into a spreadsheet cell —
-- "(move from Orthodynamo to Apex)", "(Please add this email as option 2)" —
-- and wrong for "Village Dental of New England (General Dentistry)", which is a
-- different practice from the plain one and got merged into it.
--
-- The distinction is length, not content. An aside is a sentence; a descriptor
-- is two or three words. So a bracket of three words or fewer stays part of the
-- name and anything longer is dropped as commentary, which separates every real
-- case in the data.
-- ===========================================================================

create or replace function squash_practice_name(t text)
returns text
language sql
immutable
set search_path = pg_temp
as $fn$
  with lowered as (select lower(coalesce(t, '')) as v),
  trimmed as (
    select
      case
        when v ~ '\(' and array_length(
               regexp_split_to_array(
                 trim(regexp_replace(substring(v from position('(' in v)), '[()]', '', 'g')),
                 '\s+'), 1) > 3
          then substring(v from 1 for position('(' in v) - 1)
        else v
      end as v
    from lowered
  )
  select regexp_replace(
           regexp_replace(v, '\y(llc|inc|pc|dds|dmd|and)\y', ' ', 'g'),
           '[^a-z0-9]+', '', 'g')
  from trimmed;
$fn$;

-- ===========================================================================
-- APPOINTMENTS THAT ARE NOT CONSULTATIONS
--
-- The appointments sync read every calendar a sub-account had, and only 329 of
-- the 2,411 rows it collected were on a practice booking calendar. The rest:
--
--   1,995  "Do Not Book | ..." — PatientSync mirrors and blocked slots
--      45  "Call Back Request [FOR APPT SETTERS ONLY]"
--      17  "(PatientSync)"
--      13  "Operatory 1's Personal Calendar"
--      12  virtual, second-consultation and one doctor's own exam calendar
--
-- Moved here rather than deleted. They are real appointments in a real diary,
-- just not the new-patient consultations this funnel measures, and keeping them
-- makes the exclusion auditable and reversible instead of a number that changed
-- one afternoon for reasons nobody recorded.
-- ===========================================================================

create table appointments_excluded (
  like appointments including defaults,
  calendar_name text,
  excluded_at    timestamptz not null default now(),
  reason         text not null
);

alter table appointments_excluded enable row level security;
create policy admin_all on appointments_excluded
  for all using (auth_is_admin()) with check (auth_is_admin());

-- ---------------------------------------------------------------------------
-- Keeping client_groups.status true
--
-- The column was set when a row was created and never touched again, so it
-- said 'onboarding' for 64 of 73 businesses and 'active' for none of them --
-- including practices that had been booking consultations for a year. Every
-- client count on the dashboard was wrong for as long as that was the case.
--
-- This decides it from evidence instead: a live sub-account, plus a booking, a
-- charge, or any ad spend in the last 90 days. Called at the end of the
-- crm-clients sync, so the stored answer is never older than the last run.
--
-- 'churned' and 'paused' are left alone on purpose. Those are decisions
-- somebody made, not observations, and quiet is not the same as gone.
-- ---------------------------------------------------------------------------
create or replace function refresh_client_statuses()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_changed integer;
begin
  with evidence as (
    select
      g.id,
      (
        exists (
          select 1 from clients c
          where c.group_id = g.id and c.is_active
        )
        and (
          exists (
            select 1 from tracker_appointments t
            join clients c on c.id = t.client_id
            where c.group_id = g.id
              and t.booked_for >= current_date - 90
          )
          or exists (
            select 1 from billing_charges b
            join clients c on c.id = b.client_id
            where c.group_id = g.id
              and b.occurred_at >= now() - interval '90 days'
          )
          or exists (
            select 1 from ad_snapshots s
            join clients c on c.id = s.client_id
            where c.group_id = g.id
              and s.spend_cents > 0
          )
        )
      ) as trading
    from client_groups g
    where g.status in ('active', 'onboarding')
  )
  update client_groups g
  set status = (case when e.trading then 'active' else 'onboarding' end)::client_status
  from evidence e
  where e.id = g.id
    and g.status <> (case when e.trading then 'active' else 'onboarding' end)::client_status;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$fn$;

revoke all on function refresh_client_statuses() from public;
grant execute on function refresh_client_statuses() to service_role;

-- ---------------------------------------------------------------------------
-- Which sheet a tracker lead came from
--
-- The Client Fulfilment Tracker keeps two lead sheets: "Leads Data", which is
-- the live one, and "Leads Data Old", which holds everything before it. Their
-- row numbers both start at 2, so source_row alone is not an identity and the
-- unique constraint on it silently blocked the older sheet from being imported
-- at all. Only the live sheet was in here, which is why the Hub knew about 11
-- days of leads and 37 days of ad spend and quietly divided one by the other.
--
-- The two sheets overlap for one day at the handover, 11 August, and they
-- disagree: the old sheet records 57 leads that day and the live one 11. Every
-- company in the live sheet's 11 appears in the old sheet's 57 with a count at
-- least as large, and 57 sits on the ~50/day trend while 11 does not -- so the
-- old sheet holds the whole day and the live sheet holds a re-recorded tail of
-- it. The old sheet owns 11 August and everything before; the live sheet owns
-- 12 August onward. The live sheet's 11 duplicate rows for 11 August were
-- removed, and the old sheet's 5 rows for 12 August were never imported, for
-- the same reason in the other direction.
--
-- Anything re-importing either sheet has to keep that boundary or the handover
-- day gets counted twice.
-- ---------------------------------------------------------------------------
alter table tracker_leads
  add column if not exists source_tab text not null default 'Leads Data';

alter table tracker_leads drop constraint if exists tracker_leads_source_row_key;

create unique index if not exists tracker_leads_source_tab_row_key
  on tracker_leads (source_tab, source_row);

comment on column tracker_leads.source_tab is
  'Which sheet of the Client Fulfilment Tracker the row came from. "Leads Data" and "Leads Data Old" have overlapping row numbers, so the row number alone is not an identity.';

-- ---------------------------------------------------------------------------
-- What GoHighLevel actually said the stage was
--
-- /opportunities/search returns pipelineStageId and no stage name, so the sync
-- had nothing to match against its keyword list or the configured stage map.
-- Every one of the 29 opportunities fell through to 'new', and the b2b board
-- read as a pipeline full of untouched leads. The sync now resolves names from
-- /opportunities/pipelines, and keeps the raw name and pipeline here beside the
-- mapped stage so the next mapping failure is visible instead of silent.
-- ---------------------------------------------------------------------------
alter table deals
  add column if not exists pipeline_name text,
  add column if not exists stage_name text;

comment on column deals.stage_name is
  'The stage name GoHighLevel gave, kept beside the mapped deal_stage. /opportunities/search returns only a stage id, so this is resolved from the pipeline list -- without it a mapping failure is invisible and every deal reads "new".';
comment on column deals.pipeline_name is
  'Which pipeline in the b2b sub-account the opportunity sits in. That sub-account has more than one, and they mean different things.';

-- ---------------------------------------------------------------------------
-- The two green columns the portal survey was missing
--
-- The Client Stat Sheet is the practice-facing dashboard, and its green columns
-- are the post-appointment survey: did they attend, did they attend a second
-- time, did they convert, were they approved for credit, what was it worth, and
-- why not if not. Everything but two of those already had a home here --
-- showed, outcome, value_cents, financing_approved, notes -- because the survey
-- was built before the sheet was read.
--
-- These are the two that had nowhere to go. A practice that books a second look
-- before quoting was being recorded as a first-consult no-show, which
-- understated the show rate; and card-on-file is the practice's own leading
-- indicator for whether somebody turns up.
-- ---------------------------------------------------------------------------
alter table appointments
  add column if not exists second_consult_showed boolean,
  add column if not exists cc_on_file boolean;

comment on column appointments.second_consult_showed is
  'Did they attend the second consultation. From the Client Stat Sheet, column K: a practice books a second look before quoting, and treating that absence as a first-consult no-show understated the show rate.';
comment on column appointments.cc_on_file is
  'Card on file at the time of booking. Column F of the Client Stat Sheet. Kept because it predicts attendance -- it is the practice''s own leading indicator, not a billing field.';

-- ---------------------------------------------------------------------------
-- Tracker practice names that never matched a client
--
-- Sixty-four tracker rows sat unattached because the spreadsheet writes a
-- practice differently from the CRM. Six of the eight names resolve without
-- ambiguity once looked at:
--
--   "Art of Smile"                  the CRM carries the full trading name
--   "... Apex" suffixed             the tracker appends the agency's own name
--   "Airway Orthodontics - GNV/NY"  airport-style abbreviations
--   "Airway Orthodontics - VT"      three abbreviations against four locations,
--                                   and Williston is the only one that is a real
--                                   Vermont town. Ponte Vedra has no tracker
--                                   rows at all, which is consistent.
--
-- Left alone: "Best Care Dental" and "Ofir Orthodontics", eight rows between
-- them, with no candidate anywhere in the CRM. Neither has a close or any spend,
-- so they look like practices that never onboarded. Guessing a client for them
-- would put somebody else's consultations on a real practice's numbers.
--
-- Idempotent, and only fills nulls, so a re-import re-links rather than
-- reassigning anything a human has since corrected.
-- ---------------------------------------------------------------------------
with alias(tracker_name, client_name) as (values
  ('Art of Smile',                 'Art Of Smile: Center for Cosmetic Orthodontics'),
  ('Team Dental N. Liberties Apex','Team Dental N. Liberties'),
  ('Team Dental Swedesboro Apex',  'Team Dental Swedesboro'),
  ('Airway Orthodontics - GNV',    'TMJ Sleep Airway Orthodontics - Gainesville'),
  ('Airway Orthodontics - NY',     'TMJ Sleep Airway Orthodontics - New York'),
  ('Airway Orthodontics - VT',     'TMJ Sleep Airway Orthodontics - Williston')
),
resolved as (
  select a.tracker_name, c.id as client_id
  from alias a
  join clients c on c.name = a.client_name
)
update tracker_appointments t
set client_id = r.client_id
from resolved r
where t.client_id is null and t.location_name = r.tracker_name;

-- ---------------------------------------------------------------------------
-- The agency's own sub-accounts are not clients
--
-- Seven of the 73 businesses are Apex's own: the sales pipeline, the client
-- onboarding account, snapshot and template holders, a testing ground. They were
-- appearing in lists of clients -- "ADM Testing Grounds" sat in the month over
-- month comparison with a dash in every column, and each was scored for client
-- health it could never have.
--
-- Marked rather than deleted, because two of them are load-bearing:
-- app_settings.b2b_location_id points at ADM Sales Account, and onboarding-calls
-- reads ADM Client Onboarding Account. All seven are already 'paused' with no
-- bookings, charges or spend, so no headline number moves -- this is about a
-- list of clients containing only clients.
-- ---------------------------------------------------------------------------
alter table client_groups
  add column if not exists is_internal boolean not null default false;

comment on column client_groups.is_internal is
  'The agency''s own sub-accounts rather than practices: the sales pipeline, the onboarding account, snapshot and template holders, testing grounds. They are real locations and some are load-bearing -- app_settings points at two of them -- so they are marked rather than deleted, and left out of anything that presents a list of clients.';

update client_groups
set is_internal = true
where name in (
  'ADM Client Onboarding Account',
  'ADM Ortho Snapshot',
  'ADM Push Updates',
  'ADM Sales Account',
  'ADM Team Management',
  'ADM Team Reports',
  'ADM Testing Grounds',
  -- Two more found the same way, once the agency accounts were out of the list
  -- and the remaining names could be read: a vendor trial and a vendor demo.
  -- Both paused, both with no bookings, charges or spend.
  'CloseBot v2 Test',
  'Pearl AI Dental Demo Account'
);

-- ---------------------------------------------------------------------------
-- Where a b2b lead came from, as a value rather than as prose
--
-- The manual lead form asked for a "Channel" in a text box, with "referral,
-- phone, event…" for a placeholder. Nothing wrong with the answers people would
-- type; the problem is that a rate cannot be computed from them. Referral,
-- Referral, ref and word-of-mouth are four strings and one real answer.
--
-- That matters because the referral rate is the one number Apex is working from
-- and does not have: roughly a tenth of the client base is said to refer
-- somebody each month, and that figure comes from having asked two people.
--
-- Same five values the b2b pipeline classifies contacts into, so a referral
-- logged by hand and a referral spotted from a contact tag land in the same
-- bucket. The channel column stays, still free text, for the detail behind the
-- choice -- "Dr Patel at the Boston study club" is worth keeping and is read
-- rather than counted.
-- ---------------------------------------------------------------------------
alter table b2b_leads
  add column if not exists origin lead_origin not null default 'unknown';

comment on column b2b_leads.origin is
  'Where the lead came from, as one of five values rather than free text. The channel column is still free text and still useful for the detail ("Dr Patel at the Boston study club"), but a rate cannot be computed from prose: referral, Referral, ref and word-of-mouth are four different strings and one real answer. This is the column the referral rate is counted from.';

create index if not exists b2b_leads_origin_idx on b2b_leads (origin);

-- ---------------------------------------------------------------------------
-- Attributing Stripe charges by the consultations they billed for
--
-- 107 of 127 charges belonged to nobody -- 84% of the money, $22k of $65k --
-- which made every per-client revenue figure on the Hub a guess. The cause is
-- not a bug: Stripe customers are named after the practice owner, so matching a
-- customer called "Zubad Newaz" to a practice called anything else was never
-- going to work, and the sync said so honestly.
--
-- What it did not use is the evidence already on the row. A charge lists the
-- consultations it covers, and those patients are attached to a practice. So the
-- charge can be attributed on that instead of on a name, and one identified
-- customer then attributes every charge it ever made -- including the ones
-- carrying no consultation names at all, which is where most of the remaining
-- money was.
--
-- Unanimity is required at both steps. A patient name appearing under two
-- practices resolves nothing, and a customer whose charges point at two
-- practices is left alone. Two practices sharing a patient name is rare; billing
-- one for the other's consultation would not be a rare kind of wrong.
--
-- Called at the end of stripe-charges, after the charges are written, because it
-- works on what is in the table. Idempotent.
-- ---------------------------------------------------------------------------
create or replace function attribute_billing_charges()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_customers integer;
  v_by_customer integer;
  v_by_patient integer;
begin
  create temp table pc on commit drop as
  select distinct lower(btrim(patient_name)) as patient, client_id
  from tracker_appointments
  where client_id is not null and coalesce(btrim(patient_name), '') <> ''
  union
  select distinct lower(btrim(patient_name)), client_id
  from appointments
  where client_id is not null and coalesce(btrim(patient_name), '') <> '';

  create temp table charge_patient on commit drop as
  select b.stripe_payment_intent_id as pi, b.stripe_customer_id as cust,
         lower(btrim(n)) as patient
  from billing_charges b, unnest(coalesce(b.consult_names, array[]::text[])) as n
  where btrim(n) <> '';

  with cust_map as (
    select cp.cust, min(pc.client_id::text)::uuid as client_id
    from charge_patient cp join pc on pc.patient = cp.patient
    where cp.cust is not null
    group by cp.cust
    having count(distinct pc.client_id) = 1
  ),
  saved as (
    insert into billing_customers (stripe_customer_id, client_id)
    select cust, client_id from cust_map
    on conflict (stripe_customer_id) do update
      set client_id = coalesce(billing_customers.client_id, excluded.client_id)
      where billing_customers.mapped_by_hand is not true
    returning 1
  )
  select count(*) into v_customers from saved;

  with upd as (
    update billing_charges b
    set client_id = c.client_id
    from billing_customers c
    where b.client_id is null
      and c.stripe_customer_id = b.stripe_customer_id
      and c.client_id is not null
    returning 1
  )
  select count(*) into v_by_customer from upd;

  with resolved as (
    select cp.pi, min(pc.client_id::text)::uuid as client_id
    from charge_patient cp join pc on pc.patient = cp.patient
    join billing_charges b on b.stripe_payment_intent_id = cp.pi
    where b.client_id is null
    group by cp.pi
    having count(distinct pc.client_id) = 1
  ),
  upd2 as (
    update billing_charges b
    set client_id = r.client_id
    from resolved r
    where b.stripe_payment_intent_id = r.pi and b.client_id is null
    returning 1
  )
  select count(*) into v_by_patient from upd2;

  return jsonb_build_object(
    'customers_mapped', v_customers,
    'charges_by_customer', v_by_customer,
    'charges_by_patient', v_by_patient
  );
end;
$fn$;

revoke all on function attribute_billing_charges() from public;
grant execute on function attribute_billing_charges() to service_role;

-- ---------------------------------------------------------------------------
-- Calendars that pass the name test and still are not consultations
--
-- The consultation filter is a name rule: a calendar ending "Booking Calendar".
-- That is the right rule and it is not enough. Fifteen calendars satisfy it and
-- hold no consultations -- PatientSync mirrors, blocked slots, an appointment
-- setter's call-back list, somebody's personal calendar -- and between them they
-- carried 2,068 of the 2,397 events the sync reads. One practice's mirrors alone
-- outnumbered every real booking in the agency.
--
-- They were cleared out by hand into appointments_excluded, which recorded what
-- was removed but not the decision. The sync knew nothing about it, so the next
-- run re-imported all 2,068 and the clear-out would have lasted until the
-- following evening. This table is the decision, in a form the sync reads.
--
-- Checked before seeding: no calendar appears in both the excluded set and the
-- kept set, so nothing here costs a real booking.
-- ---------------------------------------------------------------------------
create table if not exists excluded_calendars (
  crm_calendar_id text primary key,
  client_id       uuid references clients(id) on delete cascade,
  calendar_name   text,
  reason          text not null,
  excluded_at     timestamptz not null default now()
);

alter table excluded_calendars enable row level security;
drop policy if exists admin_all on excluded_calendars;
create policy admin_all on excluded_calendars
  for all using (auth_is_admin()) with check (auth_is_admin());

comment on table excluded_calendars is
  'GoHighLevel calendars whose events are not consultations, kept so the decision survives the next sync. Every one is named "... Booking Calendar" and so passes the name test -- they are PatientSync mirrors, blocked slots, call-back lists and personal calendars. Without this the nightly sync re-imports 2,068 of them and the consultation count goes back to being seven times too high.';

insert into excluded_calendars (crm_calendar_id, client_id, calendar_name, reason)
select distinct on (crm_calendar_id)
       crm_calendar_id, client_id, calendar_name, reason
from appointments_excluded
where crm_calendar_id is not null
order by crm_calendar_id, excluded_at desc
on conflict (crm_calendar_id) do nothing;

-- ---------------------------------------------------------------------------
-- Five more accounts that are not practices
--
-- Found by reading the one alert crm-appointments raises. "Ten practices have no
-- booking calendar" turned out to mean two practices and eight things that are
-- not practices: Apex's own Pay Per Show System, a vendor demo, two accounts
-- called PNW Survival Games, and a client's recruitment account. An alert that is
-- mostly noise is an alert nobody reads, so the sync now skips internal accounts
-- and the alert names only practices.
--
-- Left alone: HIP Creative, Inc., Habib Dental Implants and Skyline Implants &
-- Periodontics. All three are onboarding with no activity, and the first may be
-- a real relationship rather than scaffolding -- not mine to decide.
-- ---------------------------------------------------------------------------
update client_groups
set is_internal = true
where name in (
  'Pay Per Show System',
  'Pearl AI',
  'PNW Survival Games',
  'PNW Survival Games 2',
  'Singleton Smile [Hiring Account]'
);
