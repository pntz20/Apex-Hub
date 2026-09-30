-- CFT step 8 follow-up: a lead whose campaign was RENAMED since it clicked.
--
-- 0102 matches the utm_campaign name to the practice's synced campaigns. Leads
-- carry first-touch attribution, so a contact who clicked before a campaign
-- was renamed keeps the old name: Andros leads say "... | OD | $2000 Off" for
-- the campaign now called "... | Apex | $2000 Off"; Kind Dental "$3,475 all
-- in" for "$3,575 all in". On 30 Sep, 51 UTM-tagged leads since 16 Sep had no
-- campaign after 0102.
--
-- Fallback, campaign level only: when the name matches nothing and the
-- practice had exactly ONE campaign spending in the 30 days up to the lead
-- (or booking), that campaign is the only one the click can have come from.
-- 30 of the 51 qualify. Practices with two or more live campaigns get nothing
-- (20 of the 51): a guess between two campaigns is not attribution.
--
-- Ad set and ad are never guessed. Rows filled this way are flagged, like
-- 0102's, with ad_ids_from_names = true.

create or replace function public.fill_ad_ids_from_names()
returns trigger
language plpgsql
as $$
declare
  row_json jsonb := to_jsonb(new);
  campaign_name text := public.normalise_ad_name(row_json ->> 'utm_campaign');
  adset_name text := public.normalise_ad_name(row_json ->> 'utm_medium');
  ad_name text := public.normalise_ad_name(row_json ->> 'utm_content');
  event_day date := coalesce(
    (row_json ->> 'created_on')::date,
    (row_json ->> 'booked_at')::timestamptz::date,
    current_date
  );
  campaign_uuid uuid;
  found_id text;
  filled boolean := false;
begin
  if new.client_id is null or campaign_name is null or campaign_name like '{{%' then
    return new;
  end if;

  if new.campaign_external_id is null then
    select case when count(distinct c.external_id) = 1 then min(c.external_id) end
      into found_id
      from public.campaigns c
     where c.client_id = new.client_id
       and public.normalise_ad_name(c.name) = campaign_name;

    -- 0103: renamed campaign, practice with a single live campaign.
    if found_id is null then
      select case when count(distinct c.external_id) = 1 then min(c.external_id) end
        into found_id
        from public.campaigns c
        join public.ad_level_insights i on i.campaign_id = c.id
       where c.client_id = new.client_id
         and i.spend_cents > 0
         and i.insight_on between event_day - 30 and event_day;
    end if;

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

-- Backfill the rows still without a campaign.
update public.crm_leads
   set utm_campaign = utm_campaign
 where utm_campaign is not null and campaign_external_id is null;

update public.appointments
   set utm_campaign = utm_campaign
 where utm_campaign is not null and campaign_external_id is null;
