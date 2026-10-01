-- 0108: CFT step 10. Calls matched to the lead's campaign.
--
-- A dial carries no campaign, so until now the tracker spread each practice's
-- calls over its campaign rows by lead share. This matches each dial to the
-- campaign of the lead it called: same practice, same last-10-digit phone,
-- using the most recent HighLevel lead or booking with a campaign id for that
-- number. Measured 16-30 Sep: 3,585 of 7,100 outbound dials (50%) match; the
-- rest are mostly older leads re-dialled from before crm_leads began (9 Sep).
-- The tracker keeps apportioning only the unmatched remainder.
--
-- Same dial set as v_cft_call_daily: the dial log on days it has, HighLevel
-- calls otherwise, days in call_centre_time_zone().
--
-- A function rather than a view: the planner misestimates the dial CTE as one
-- row and picks a nested loop (10 s); with nested loops off it is ~0.5 s.
-- Service role only - it reads patient phone numbers to do the match.

create or replace function public.cft_call_campaign_daily(p_from date, p_to date)
returns table (
  client_id uuid,
  campaign_external_id text,
  day date,
  dialed_calls bigint,
  calls_2min bigint,
  calls_2min_outbound bigint,
  connected_outbound bigint,
  answered_outbound bigint,
  connected_but_silent bigint
)
language sql
stable
set enable_nestloop = off
as $$
  with dials as (
    select d.source, d.client_id, d.direction, d.connected, d.picked_up,
           d.duration_seconds, d.phone10,
           (d.dialled_at at time zone call_centre_time_zone())::date as day
      from v_call_centre_dials d
     where d.client_id is not null and d.phone10 is not null
  ), dial_log_days as (
    select distinct dials.day from dials where dials.source = 'hotprospector'
  ), chosen as (
    select d.* from dials d
     where d.day between p_from and p_to
       and d.source = case
             when exists (select 1 from dial_log_days x where x.day = d.day) then 'hotprospector'
             else 'highlevel'
           end
  ), leads as (
    select l.client_id, right(regexp_replace(l.lead_phone, '\D', '', 'g'), 10) as phone10,
           l.campaign_external_id, l.created_at_utc as seen_at
      from crm_leads l
     where l.campaign_external_id is not null
    union all
    select a.client_id, right(regexp_replace(a.patient_phone, '\D', '', 'g'), 10),
           a.campaign_external_id, a.booked_at
      from appointments a
     where a.campaign_external_id is not null
  ), phone_campaign as (
    select distinct on (leads.client_id, leads.phone10)
           leads.client_id, leads.phone10, leads.campaign_external_id
      from leads
     where leads.phone10 <> ''
     order by leads.client_id, leads.phone10, leads.seen_at desc nulls last
  )
  select c.client_id, pc.campaign_external_id, c.day,
         count(*) filter (where c.direction = 'outbound'),
         count(*) filter (where c.picked_up and c.duration_seconds >= 120),
         count(*) filter (where c.direction = 'outbound' and c.picked_up and c.duration_seconds >= 120),
         count(*) filter (where c.direction = 'outbound' and c.connected),
         count(*) filter (where c.direction = 'outbound' and c.picked_up),
         count(*) filter (where c.direction = 'outbound' and c.connected and not c.picked_up)
    from chosen c
    join phone_campaign pc on pc.client_id = c.client_id and pc.phone10 = c.phone10
   group by c.client_id, pc.campaign_external_id, c.day
$$;

revoke execute on function public.cft_call_campaign_daily(date, date) from public;
revoke execute on function public.cft_call_campaign_daily(date, date) from anon;
revoke execute on function public.cft_call_campaign_daily(date, date) from authenticated;
grant execute on function public.cft_call_campaign_daily(date, date) to service_role;
