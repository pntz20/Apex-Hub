-- 0097: bookings made before 0094 get their ad ids, and the campaign comes from the ad set.
--
-- Two gaps left after 0094 (see claude/cft-sop-steps.md step 5):
--
-- 1. crm-appointments reads a contact once per booking. patient_name was the
--    "already enriched" sentinel, so every booking enriched before 0094 went
--    out of date: it has a name and never gets its campaign / ad set / ad id.
--    attribution_read_at is the new sentinel. It is set when the contact was
--    read by code that knows about attributionSource, and the sync re-reads
--    bookings where it is null (within a small per-run budget).
--
-- 2. Many contacts carry only the ad set id (from utm_term). Meta ad set ids
--    belong to exactly one campaign, and ad_sets already records which, so the
--    campaign id can be filled from there. A trigger does it on every write to
--    crm_leads and appointments, and a trigger on ad_sets fills rows written
--    before their ad set was first synced.

alter table public.appointments
  add column if not exists attribution_read_at timestamptz;

comment on column public.appointments.attribution_read_at is
  'When crm-appointments last read this booking''s contact for attribution (attributionSource). Null = never read by that code; the sync re-reads these.';

-- Bookings that already carry an id were read by the current code.
update public.appointments
   set attribution_read_at = coalesce(synced_at, now())
 where attribution_read_at is null
   and (ad_external_id is not null or adset_external_id is not null or campaign_external_id is not null);

-- Campaign external id for an ad set external id. Prefers the same client,
-- but falls back to any client: an ad set id is unique across Meta, and ad
-- account ownership has moved between clients before.
create or replace function public.campaign_for_ad_set(p_adset_external_id text, p_client_id uuid)
returns text
language sql
stable
set search_path to 'public'
as $$
  select c.external_id
    from ad_sets s
    join campaigns c on c.id = s.campaign_id
   where s.external_id = p_adset_external_id
     and c.external_id is not null
   order by (s.client_id = p_client_id) desc nulls last, s.updated_at desc nulls last
   limit 1;
$$;

create or replace function public.fill_campaign_from_ad_set()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.campaign_external_id is null and new.adset_external_id is not null then
    new.campaign_external_id := campaign_for_ad_set(new.adset_external_id, new.client_id);
  end if;
  return new;
end;
$$;

drop trigger if exists crm_leads_campaign_from_ad_set on public.crm_leads;
create trigger crm_leads_campaign_from_ad_set
  before insert or update of adset_external_id, campaign_external_id on public.crm_leads
  for each row execute function public.fill_campaign_from_ad_set();

drop trigger if exists appointments_campaign_from_ad_set on public.appointments;
create trigger appointments_campaign_from_ad_set
  before insert or update of adset_external_id, campaign_external_id on public.appointments
  for each row execute function public.fill_campaign_from_ad_set();

-- When an ad set is first synced (or moves campaign), fill leads and bookings
-- that arrived with only its id.
create or replace function public.ad_set_fills_campaigns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_campaign text;
begin
  if new.external_id is null or new.campaign_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.campaign_id is not distinct from old.campaign_id
     and new.external_id is not distinct from old.external_id then
    return new;
  end if;

  select external_id into v_campaign from campaigns where id = new.campaign_id;
  if v_campaign is null then
    return new;
  end if;

  update crm_leads set campaign_external_id = v_campaign
   where adset_external_id = new.external_id and campaign_external_id is null;
  update appointments set campaign_external_id = v_campaign
   where adset_external_id = new.external_id and campaign_external_id is null;
  return new;
end;
$$;

revoke all on function public.ad_set_fills_campaigns() from public, anon, authenticated;

drop trigger if exists ad_sets_fill_campaigns on public.ad_sets;
create trigger ad_sets_fill_campaigns
  after insert or update of campaign_id, external_id on public.ad_sets
  for each row execute function public.ad_set_fills_campaigns();

-- One-off backfill.
update public.crm_leads l
   set campaign_external_id = public.campaign_for_ad_set(l.adset_external_id, l.client_id)
 where l.campaign_external_id is null and l.adset_external_id is not null;

update public.appointments a
   set campaign_external_id = public.campaign_for_ad_set(a.adset_external_id, a.client_id)
 where a.campaign_external_id is null and a.adset_external_id is not null;

-- Bookings with no ids at all take them from the same contact's lead row.
update public.appointments a
   set ad_external_id = l.ad_external_id,
       adset_external_id = l.adset_external_id,
       campaign_external_id = l.campaign_external_id
  from public.crm_leads l
 where l.client_id = a.client_id
   and l.crm_contact_id = a.crm_contact_id
   and a.ad_external_id is null and a.adset_external_id is null and a.campaign_external_id is null
   and (l.ad_external_id is not null or l.adset_external_id is not null or l.campaign_external_id is not null);
