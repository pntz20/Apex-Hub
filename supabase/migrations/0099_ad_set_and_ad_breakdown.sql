-- 0099: the tracker gets ad set and ad breakdowns (CFT to SOP, step 17).
--
-- v_cft_ad_daily is one row per client x day x campaign x ad set x ad, with
-- every numeric column additive (aggregate first, then divide - same rule as
-- v_cft_stats_dashboard).
--
-- Three feeds, each attributed as far as its own ids go:
--   * spend, impressions, clicks, leads_meta  <- ad_level_insights via ads.
--     Every ad carries a real ad set id since 0093, so spend is fully
--     attributed down to the ad.
--   * leads_crm                               <- crm_leads (HighLevel).
--   * bookings, shows, no_shows, cancels,
--     revenue_cents                           <- appointments (HighLevel),
--     outcome from appointment_ledger, treatment value from stat sheets
--     (same source as 0095).
--
-- A lead or booking with only an ad id gets its ad set from ads; one with
-- only an ad set gets its campaign from ad_sets. Anything with no ad set at
-- all keeps adset_external_id NULL: that is the practice's "unattributed"
-- remainder, and it is kept, not dropped, so a practice's rows always add up
-- to its real lead and booking totals.
--
-- Measured 28 Sep 2026, last 30 days: spend $52,036.30 fully attributed;
-- 129 of 1,460 CRM leads and 26 of 182 bookings carry an ad set, none an ad.
-- The page shows cost-per figures only where a practice's coverage is high
-- enough to mean something (src/lib/cft-ads.ts, COVERAGE_FLOOR).
--
-- leads_meta is Meta's own lead count and runs far below CRM leads (82 vs
-- 1,460 over the same 30 days): Windsor's `leads` metric looks like on-Facebook
-- lead forms only. Kept as its own column rather than mixed into leads_crm.

create or replace view public.v_cft_ad_daily
with (security_invoker = true) as
with ins as (
  select i.client_id,
         i.insight_on                        as day,
         cmp.external_id                     as campaign_id,
         d.adset_external_id                 as adset_id,
         d.external_id                       as ad_id,
         sum(i.spend_cents)::bigint          as spend_cents,
         sum(i.impressions)::bigint          as impressions,
         sum(i.clicks)::bigint               as clicks,
         sum(i.leads)::bigint                as leads_meta
    from ad_level_insights i
    join ads d on d.id = i.ad_id
    left join campaigns cmp on cmp.id = i.campaign_id
   where i.client_id is not null
   group by 1, 2, 3, 4, 5
), ld as (
  select l.client_id,
         l.created_on                                          as day,
         coalesce(l.campaign_external_id, sc.external_id)      as campaign_id,
         coalesce(l.adset_external_id, d.adset_external_id)    as adset_id,
         l.ad_external_id                                      as ad_id,
         count(*)::bigint                                      as leads_crm
    from crm_leads l
    left join lateral (
      select x.adset_external_id from ads x
       where x.client_id = l.client_id and x.external_id = l.ad_external_id
       limit 1
    ) d on true
    left join lateral (
      select s.campaign_id from ad_sets s
       where s.client_id = l.client_id
         and s.external_id = coalesce(l.adset_external_id, d.adset_external_id)
       limit 1
    ) s on true
    left join campaigns sc on sc.id = s.campaign_id
   where l.client_id is not null and l.created_on is not null
   group by 1, 2, 3, 4, 5
), bk as (
  select distinct on (a.client_id, a.crm_appointment_id)
         a.client_id,
         a.crm_appointment_id,
         (a.booked_at at time zone 'UTC')::date                as day,
         coalesce(a.campaign_external_id, sc.external_id)      as campaign_id,
         coalesce(a.adset_external_id, d.adset_external_id)    as adset_id,
         a.ad_external_id                                      as ad_id
    from appointments a
    left join lateral (
      select x.adset_external_id from ads x
       where x.client_id = a.client_id and x.external_id = a.ad_external_id
       limit 1
    ) d on true
    left join lateral (
      select s.campaign_id from ad_sets s
       where s.client_id = a.client_id
         and s.external_id = coalesce(a.adset_external_id, d.adset_external_id)
       limit 1
    ) s on true
    left join campaigns sc on sc.id = s.campaign_id
   where a.client_id is not null
     and a.crm_appointment_id is not null
     and a.booked_at is not null
   order by a.client_id, a.crm_appointment_id, a.adset_external_id nulls last
), tv as (
  select appointment_external_id                  as crm_appointment_id,
         max(treatment_value_cents)::bigint       as value_cents
    from stat_sheet_appointments
   where appointment_external_id is not null and treatment_value_cents > 0
   group by 1
), bo as (
  select b.client_id, b.day, b.campaign_id, b.adset_id, b.ad_id,
         count(*)::bigint                                                         as bookings,
         count(*) filter (where lg.outcome = 'showed')::bigint                    as shows,
         count(*) filter (where lg.outcome = 'no_show')::bigint                   as no_shows,
         count(*) filter (where lg.cancelled_at is not null
                             or lg.outcome = 'cancelled')::bigint                 as cancels,
         coalesce(sum(tv.value_cents), 0)::bigint                                 as revenue_cents
    from bk b
    left join lateral (
      select l.outcome, l.cancelled_at from appointment_ledger l
       where l.client_id = b.client_id and l.crm_appointment_id = b.crm_appointment_id
       limit 1
    ) lg on true
    left join tv on tv.crm_appointment_id = b.crm_appointment_id
   group by 1, 2, 3, 4, 5
), u as (
  select client_id, day, campaign_id, adset_id, ad_id,
         spend_cents, impressions, clicks, leads_meta,
         0::bigint as leads_crm, 0::bigint as bookings, 0::bigint as shows,
         0::bigint as no_shows, 0::bigint as cancels, 0::bigint as revenue_cents
    from ins
  union all
  select client_id, day, campaign_id, adset_id, ad_id,
         0, 0, 0, 0, leads_crm, 0, 0, 0, 0, 0
    from ld
  union all
  select client_id, day, campaign_id, adset_id, ad_id,
         0, 0, 0, 0, 0, bookings, shows, no_shows, cancels, revenue_cents
    from bo
), g as (
  select client_id, day, campaign_id, adset_id, ad_id,
         sum(spend_cents)::bigint   as spend_cents,
         sum(impressions)::bigint   as impressions,
         sum(clicks)::bigint        as clicks,
         sum(leads_meta)::bigint    as leads_meta,
         sum(leads_crm)::bigint     as leads_crm,
         sum(bookings)::bigint      as bookings,
         sum(shows)::bigint         as shows,
         sum(no_shows)::bigint      as no_shows,
         sum(cancels)::bigint       as cancels,
         sum(revenue_cents)::bigint as revenue_cents
    from u
   group by 1, 2, 3, 4, 5
)
select g.client_id,
       cl.name                              as client_name,
       cl.group_id,
       case
         when grp.status = 'churned'::client_status then 'Churned'
         when cl.is_active then 'Active'
         else 'Paused'
       end                                  as status,
       g.day,
       g.campaign_id                        as campaign_external_id,
       cmp.name                             as campaign_name,
       g.adset_id                           as adset_external_id,
       coalesce(st.name, ad.adset_name)     as adset_name,
       g.ad_id                              as ad_external_id,
       ad.name                              as ad_name,
       g.spend_cents, g.impressions, g.clicks, g.leads_meta, g.leads_crm,
       g.bookings, g.shows, g.no_shows, g.cancels, g.revenue_cents
  from g
  join clients cl on cl.id = g.client_id
  left join client_groups grp on grp.id = cl.group_id
  left join lateral (
    select c.name from campaigns c
     where c.client_id = g.client_id and c.external_id = g.campaign_id
     limit 1
  ) cmp on true
  left join lateral (
    select s.name from ad_sets s
     where s.client_id = g.client_id and s.external_id = g.adset_id
     limit 1
  ) st on true
  left join lateral (
    select x.name, x.adset_name from ads x
     where x.client_id = g.client_id
       and x.external_id = coalesce(g.ad_id, '')
     limit 1
  ) ad on true
 where not cl.is_internal;

comment on view public.v_cft_ad_daily is
  'Tracker ad set / ad breakdown (CFT step 17). client x day x campaign x ad set x ad; all numeric columns additive. '
  'Spend is fully attributed via ads; leads_crm and bookings only as far as HighLevel attribution carries an ad set or ad id. '
  'adset_external_id NULL = the practice''s unattributed leads/bookings, kept so rows sum to real totals. '
  'leads_meta = Windsor/Meta lead count (lead forms), not comparable to leads_crm. See 0099.';

revoke all on public.v_cft_ad_daily from anon;
grant select on public.v_cft_ad_daily to authenticated, service_role;
