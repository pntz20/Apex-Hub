-- CFT step 8: leads and bookings carry the ad's NAMES but not its IDS.
--
-- Checked 30 Sep 2026, a day after the UTM rollout (step 7):
--   * crm_leads since 16 Sep: 630 with a utm_campaign, 112 with an ad set id,
--     0 with an ad id, every day, including after the rollout. The new URL
--     parameters campaign_id / adset_id / ad_id reach the landing page but
--     HighLevel does not keep them; it keeps only the standard utm_* fields.
--   * utm_campaign = {{campaign.name}}, utm_medium = {{adset.name}},
--     utm_content = {{ad.name}}, and those do arrive.
--
-- So the ids are looked up from the names, inside the practice's own synced
-- ads (campaigns / ad_sets / ads, from Windsor), and only when exactly one
-- campaign / ad set / ad has that name. An ambiguous name fills nothing.
--
-- Validated before writing this: where a lead already had the id, the name
-- match agreed 83 of 83 times for campaigns and 6 of 6 for ad sets. A unique
-- campaign name matched 509 of 630 leads and a unique ad set 410 (was 112).
-- Ad level is matched inside the resolved ad set only; ad names repeat
-- across ad sets (182 ambiguous without that constraint).
--
-- An id HighLevel did send is never replaced. Rows filled here are flagged
-- ad_ids_from_names = true so the two can always be told apart.

create or replace function public.normalise_ad_name(value text)
returns text
language sql
immutable
as $$
  select nullif(lower(regexp_replace(btrim(value), '\s+', ' ', 'g')), '')
$$;

alter table public.crm_leads
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists ad_ids_from_names boolean not null default false;

alter table public.appointments
  add column if not exists ad_ids_from_names boolean not null default false;

create or replace function public.fill_ad_ids_from_names()
returns trigger
language plpgsql
as $$
declare
  row_json jsonb := to_jsonb(new);
  campaign_name text := public.normalise_ad_name(row_json ->> 'utm_campaign');
  adset_name text := public.normalise_ad_name(row_json ->> 'utm_medium');
  ad_name text := public.normalise_ad_name(row_json ->> 'utm_content');
  campaign_uuid uuid;
  found_id text;
  filled boolean := false;
begin
  -- Unfilled macros ("{{campaign.name}}") are ads whose URL was never set up.
  if new.client_id is null or campaign_name is null or campaign_name like '{{%' then
    return new;
  end if;

  if new.campaign_external_id is null then
    select case when count(distinct c.external_id) = 1 then min(c.external_id) end
      into found_id
      from public.campaigns c
     where c.client_id = new.client_id
       and public.normalise_ad_name(c.name) = campaign_name;
    if found_id is not null then
      new.campaign_external_id := found_id;
      filled := true;
    end if;
  end if;

  if new.campaign_external_id is null then
    new.ad_ids_from_names := new.ad_ids_from_names or filled;
    return new;
  end if;

  select c.id into campaign_uuid
    from public.campaigns c
   where c.client_id = new.client_id
     and c.external_id = new.campaign_external_id
   limit 1;

  if new.adset_external_id is null and campaign_uuid is not null
     and adset_name is not null and adset_name not like '{{%' then
    select case when count(distinct s.external_id) = 1 then min(s.external_id) end
      into found_id
      from public.ad_sets s
     where s.campaign_id = campaign_uuid
       and public.normalise_ad_name(s.name) = adset_name;
    if found_id is not null then
      new.adset_external_id := found_id;
      filled := true;
    end if;
  end if;

  if new.ad_external_id is null and new.adset_external_id is not null
     and ad_name is not null and ad_name not like '{{%' then
    select case when count(distinct a.external_id) = 1 then min(a.external_id) end
      into found_id
      from public.ads a
     where a.client_id = new.client_id
       and a.adset_external_id = new.adset_external_id
       and public.normalise_ad_name(a.name) = ad_name;
    if found_id is not null then
      new.ad_external_id := found_id;
      filled := true;
    end if;
  end if;

  new.ad_ids_from_names := new.ad_ids_from_names or filled;
  return new;
end;
$$;

-- Every sync upserts the row with HighLevel's (null) ids again, which fires
-- this before the write, so a filled id survives re-syncs.
drop trigger if exists crm_leads_fill_ad_ids on public.crm_leads;
create trigger crm_leads_fill_ad_ids
  before insert or update on public.crm_leads
  for each row execute function public.fill_ad_ids_from_names();

drop trigger if exists appointments_fill_ad_ids on public.appointments;
create trigger appointments_fill_ad_ids
  before insert or update on public.appointments
  for each row execute function public.fill_ad_ids_from_names();

-- Backfill: touching the row runs the trigger.
update public.crm_leads
   set utm_campaign = utm_campaign
 where utm_campaign is not null
   and (campaign_external_id is null or adset_external_id is null or ad_external_id is null);

update public.appointments
   set utm_campaign = utm_campaign
 where utm_campaign is not null
   and (campaign_external_id is null or adset_external_id is null or ad_external_id is null);
