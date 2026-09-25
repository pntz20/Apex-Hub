/*
 * Calls come from the dial log.
 *
 * v_cft_call_daily counted HighLevel's calls table: 1,398 calls in the last 60
 * days against 11,699 in the HotProspector dial log (raw_call_rows) that the
 * call centre actually works from. The Fulfilment Sheet SOP's call data is the
 * dial log. So the tracker's Dialed, Calls 2+ min, Pickup % and Conversation %
 * now come from raw_call_rows.
 *
 * FALL BACK PER DAY
 *
 * The dial log is written by Make scenario 5560467, and it has no calls after
 * 16 Sep 2026. On any day with no dial log rows at all, the day falls back to
 * HighLevel calls, so the tracker never shows zero just because the feed
 * stalled. call_source (appended at the end of the view) says which one each
 * row used.
 *
 * DIAL LOG TIMES ARE THE LEAD'S LOCAL WALL-CLOCK TIME
 *
 * called_at was parsed as UTC, but the sheet writes each call in the lead's own
 * time zone (the time_zone column). Checked against call_summaries on 24 Sep:
 * New York rows read 180 min ahead, Chicago 120, Los Angeles 0. Converted, 99.8%
 * of dials fall between 06:00 and 18:00 Pacific, Monday to Saturday, which is
 * when the ISRs log in. raw_call_rows itself is NOT changed here: pay and
 * commission count its called_on exactly as the sheet's COUNTIFS does. The
 * correction lives in v_call_centre_dials.
 *
 * PICKUP COMES FROM THE DISPOSITION, NOT THE DURATION
 *
 * The dial log's duration includes ringing: "No Answer" dials have a median of
 * 31 s, and 97% of all dials last longer than 0 s. So on the dial log a pickup
 * is a dial the agent gave a disposition other than "No Answer" (Hang Up, Not
 * Interested, Booked, Call Back, Wrong Number and so on all mean somebody
 * answered). About 17% of dials. A conversation is a pickup of 120 s or more.
 * HighLevel calls keep their existing rule (talk time > 0).
 *
 * DUPLICATES
 *
 * 950 of 16,355 dated dial log rows repeat another row exactly (same lead, time,
 * duration, agent and direction). The tracker counts each dial once.
 *
 * SPEED TO LEAD
 *
 * Nothing ever filled calls.speed_to_lead_minutes, so Speed To Lead was always
 * blank. It is now: HighLevel lead created (crm_leads.created_at_utc) to the
 * first outbound dial to that lead's phone number, counting only call-centre
 * working time (app_settings.call_centre_hours, default 06:00-18:00
 * America/Los_Angeles, Monday-Saturday). A lead that arrives at 11 PM and is
 * dialled at 6:05 AM is 5 minutes, not 7 hours. Dial log lead ids are
 * HotProspector ids, not HighLevel contact ids, so the link is the phone
 * number: every one of the 304 leads created since 10 Sep that the centre
 * dialled matches a HighLevel lead that way.
 */

-- ---------------------------------------------------------------------------
-- Working hours
-- ---------------------------------------------------------------------------

insert into public.app_settings (key, value, description)
values (
  'call_centre_hours',
  '{"time_zone": "America/Los_Angeles", "opens": "06:00", "closes": "18:00", "days": [1, 2, 3, 4, 5, 6]}'::jsonb,
  'When the call centre is working. Speed to lead counts only this time. days are ISO weekdays (1 = Monday). Also sets which calendar day a dial belongs to on the tracker.'
)
on conflict (key) do nothing;

create or replace function public.call_centre_time_zone()
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select value->>'time_zone' from app_settings where key = 'call_centre_hours'),
    'America/Los_Angeles'
  );
$$;

/*
 * Minutes of call-centre working time between two instants. Zero when to_at is
 * not after from_at.
 */
create or replace function public.call_centre_minutes_between(from_at timestamptz, to_at timestamptz)
returns numeric
language sql
stable
set search_path = public
as $$
  with h as (
    select
      coalesce(s.value->>'time_zone', 'America/Los_Angeles') as tz,
      coalesce((s.value->>'opens')::time, time '06:00') as opens,
      coalesce((s.value->>'closes')::time, time '18:00') as closes,
      coalesce(
        (select array_agg(d::int) from jsonb_array_elements_text(s.value->'days') d),
        array[1, 2, 3, 4, 5, 6]
      ) as days
    from (select coalesce(
            (select value from app_settings where key = 'call_centre_hours'),
            '{}'::jsonb) as value) s
  ),
  d as (
    select h.tz, h.opens, h.closes, g::date as day
    from h,
         generate_series(
           (from_at at time zone h.tz)::date,
           (to_at at time zone h.tz)::date,
           interval '1 day'
         ) g
    where to_at > from_at
      and extract(isodow from g)::int = any (h.days)
  )
  select coalesce(sum(greatest(0::numeric,
    extract(epoch from (
      least(to_at, (day + closes) at time zone tz)
      - greatest(from_at, (day + opens) at time zone tz)
    ))::numeric / 60
  )), 0)
  from d;
$$;

-- ---------------------------------------------------------------------------
-- Every dial, both feeds, on true instants
-- ---------------------------------------------------------------------------

create or replace view public.v_call_centre_dials as
with raw as (
  select distinct on (
           r.lead_crm_id, r.called_at, coalesce(r.duration_seconds, -1),
           coalesce(r.agent_name, ''), coalesce(r.direction, '')
         )
         r.id,
         r.client_id,
         case
           when r.time_zone in (select name from pg_timezone_names)
             then (r.called_at at time zone 'UTC') at time zone r.time_zone
           else r.called_at
         end as dialled_at,
         lower(r.direction) as direction,
         r.status,
         nullif(trim(r.disposition), '') is not null
           and lower(trim(r.disposition)) <> 'no answer' as picked_up,
         coalesce(r.duration_seconds, 0) as duration_seconds,
         right(regexp_replace(
           case when lower(r.direction) = 'inbound' then r.from_number else r.to_number end,
           '\D', '', 'g'), 10) as phone10
  from public.raw_call_rows r
  where r.called_at is not null
  order by r.lead_crm_id, r.called_at, coalesce(r.duration_seconds, -1),
           coalesce(r.agent_name, ''), coalesce(r.direction, ''), r.source_row
)
select 'hotprospector'::text as source,
       r.id::text as dial_id,
       r.client_id,
       r.dialled_at,
       r.direction,
       r.status = 'completed' as connected,
       r.picked_up,
       r.duration_seconds,
       r.phone10
from raw r
union all
select 'highlevel'::text,
       c.id::text,
       c.client_id,
       c.started_at,
       c.direction::text,
       c.outcome::text = 'connected',
       coalesce(c.duration_seconds, 0) > 0,
       coalesce(c.duration_seconds, 0),
       right(regexp_replace(c.contact_phone, '\D', '', 'g'), 10)
from public.calls c
where c.started_at is not null;

alter view public.v_call_centre_dials set (security_invoker = on);

comment on view public.v_call_centre_dials is
  'Every call from both feeds (HotProspector dial log, HighLevel calls) on its true instant. Dial log times are converted from the lead''s local time_zone; exact duplicate dial log rows are counted once. See migration 0096.';

-- ---------------------------------------------------------------------------
-- Speed to lead, one row per HighLevel lead that has been dialled
-- ---------------------------------------------------------------------------

create or replace view public.v_lead_speed_to_lead as
with leads as (
  select l.id as lead_id,
         l.client_id,
         l.created_at_utc,
         l.campaign_external_id,
         l.adset_external_id,
         l.ad_external_id,
         right(regexp_replace(l.lead_phone, '\D', '', 'g'), 10) as phone10
  from public.crm_leads l
  where l.created_at_utc is not null
    and length(regexp_replace(coalesce(l.lead_phone, ''), '\D', '', 'g')) >= 10
),
first_dial as (
  select distinct on (le.lead_id)
         le.*,
         d.dialled_at as first_dialled_at,
         d.source as first_dial_source
  from leads le
  join public.v_call_centre_dials d
    on d.phone10 = le.phone10
   and d.direction = 'outbound'
   and (d.client_id is null or d.client_id = le.client_id)
   -- A few minutes of clock skew between HighLevel and the dialler.
   and d.dialled_at >= le.created_at_utc - interval '5 minutes'
  order by le.lead_id, d.dialled_at
)
select f.lead_id,
       f.client_id,
       f.created_at_utc,
       f.first_dialled_at,
       f.first_dial_source,
       f.campaign_external_id,
       f.adset_external_id,
       f.ad_external_id,
       public.call_centre_minutes_between(f.created_at_utc, f.first_dialled_at) as working_minutes,
       round(extract(epoch from (f.first_dialled_at - f.created_at_utc))::numeric / 60, 1) as clock_minutes
from first_dial f;

alter view public.v_lead_speed_to_lead set (security_invoker = on);

comment on view public.v_lead_speed_to_lead is
  'HighLevel lead created to first outbound dial to its phone number, in call-centre working minutes (app_settings.call_centre_hours) and in clock minutes. Leads never dialled are not listed. See migration 0096.';

-- ---------------------------------------------------------------------------
-- The tracker's daily call counts
-- ---------------------------------------------------------------------------

create or replace view public.v_cft_call_daily as
with dials as (
  select d.*, (d.dialled_at at time zone public.call_centre_time_zone())::date as day
  from public.v_call_centre_dials d
  where d.client_id is not null
),
dial_log_days as (
  select distinct day from dials where source = 'hotprospector'
),
chosen as (
  select d.*
  from dials d
  where d.source = case
          when exists (select 1 from dial_log_days x where x.day = d.day) then 'hotprospector'
          else 'highlevel'
        end
),
counts as (
  select client_id,
         day,
         min(source) as call_source,
         count(*) as calls_total,
         count(*) filter (where direction = 'outbound') as dialed_calls,
         count(*) filter (where direction = 'inbound') as inbound_calls,
         count(*) filter (where direction = 'outbound' and connected) as connected_outbound,
         count(*) filter (where connected) as connected_any,
         count(*) filter (where picked_up and duration_seconds >= 120) as calls_2min,
         count(*) filter (where direction = 'outbound' and picked_up) as answered_outbound,
         count(*) filter (where direction = 'outbound' and connected and not picked_up) as connected_but_silent,
         count(*) filter (where direction = 'outbound' and picked_up and duration_seconds >= 120) as calls_2min_outbound
  from chosen
  group by client_id, day
),
speed as (
  select client_id,
         (first_dialled_at at time zone public.call_centre_time_zone())::date as day,
         coalesce(sum(working_minutes) filter (where working_minutes <= 1440), 0) as speed_to_lead_min_sum,
         count(*) filter (where working_minutes <= 1440) as speed_to_lead_n,
         count(*) filter (where working_minutes > 1440) as speed_to_lead_over_24h
  from public.v_lead_speed_to_lead
  where client_id is not null
  group by 1, 2
),
spine as (
  select client_id, day from counts
  union
  select client_id, day from speed
)
select s.client_id,
       cl.name as client_name,
       cl.group_id,
       s.day,
       coalesce(c.calls_total, 0)::bigint as calls_total,
       coalesce(c.dialed_calls, 0)::bigint as dialed_calls,
       coalesce(c.inbound_calls, 0)::bigint as inbound_calls,
       coalesce(c.connected_outbound, 0)::bigint as connected_outbound,
       coalesce(c.connected_any, 0)::bigint as connected_any,
       coalesce(c.calls_2min, 0)::bigint as calls_2min,
       coalesce(sp.speed_to_lead_min_sum, 0)::numeric as speed_to_lead_min_sum,
       coalesce(sp.speed_to_lead_n, 0)::bigint as speed_to_lead_n,
       coalesce(sp.speed_to_lead_over_24h, 0)::bigint as speed_to_lead_over_24h,
       coalesce(c.answered_outbound, 0)::bigint as answered_outbound,
       coalesce(c.connected_but_silent, 0)::bigint as connected_but_silent,
       coalesce(c.calls_2min_outbound, 0)::bigint as calls_2min_outbound,
       -- Appended: which feed this client-day's counts came from.
       coalesce(c.call_source, 'none') as call_source
from spine s
join public.clients cl on cl.id = s.client_id
left join counts c on c.client_id = s.client_id and c.day = s.day
left join speed sp on sp.client_id = s.client_id and sp.day = s.day;

alter view public.v_cft_call_daily set (security_invoker = on);

comment on view public.v_cft_call_daily is
  'Tracker call counts per client per call-centre day (app_settings.call_centre_hours time zone). From the HotProspector dial log on days it has rows, HighLevel calls otherwise (call_source). Pickup = outbound the agent dispositioned as anything but No Answer (dial log) or with talk time > 0 (HighLevel); Conversation = outbound pickup of 120 s+; Speed To Lead = working minutes from lead created to first dial, averaged over leads first dialled that day, 24 working hours or less. See migration 0096.';

-- The new helper views are for the service role only, like the other
-- service-only views locked down in the 23 Sep rebuild.
revoke all on public.v_call_centre_dials from anon, authenticated;
revoke all on public.v_lead_speed_to_lead from anon, authenticated;
revoke all on function public.call_centre_minutes_between(timestamptz, timestamptz) from public, anon;
revoke all on function public.call_centre_time_zone() from public, anon;
grant execute on function public.call_centre_minutes_between(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.call_centre_time_zone() to authenticated, service_role;
