-- 0098: pay and commission count each dial once.
--
-- The HotProspector dial log (raw_call_rows) holds exact duplicate rows: on
-- 28 Sep, 955 of 16,387 dated rows, 50 of them "Booked" (7 in the last 30
-- days). The tracker already dedupes (v_call_centre_dials, 0096), but the pay
-- and commission views counted every row, so a duplicated booking paid twice.
--
-- v_raw_call_rows_deduped keeps one row per (lead, called_at, duration, agent,
-- direction), the same key v_call_centre_dials uses, lowest source_row wins.
-- Undated rows pass through untouched: without a time there is nothing to
-- tell a duplicate from a second call.
--
-- The five views that read raw_call_rows are rebuilt from their current
-- definitions with only the source swapped, so their columns don't change.

create or replace view public.v_raw_call_rows_deduped
with (security_invoker = on) as
select * from (
  select distinct on (
           r.lead_crm_id, r.called_at, coalesce(r.duration_seconds, -1),
           coalesce(r.agent_name, ''), coalesce(r.direction, '')
         ) r.*
    from public.raw_call_rows r
   where r.called_at is not null
   order by r.lead_crm_id, r.called_at, coalesce(r.duration_seconds, -1),
            coalesce(r.agent_name, ''), coalesce(r.direction, ''), r.source_row
) dated
union all
select r.* from public.raw_call_rows r where r.called_at is null;

comment on view public.v_raw_call_rows_deduped is
  'raw_call_rows with exact duplicate dials removed (0098). Pay, commission and portal call counts read this.';

-- security_invoker, so raw_call_rows' RLS still decides what a signed-in user
-- sees; the invoker views built on it need SELECT here for that user.
revoke all on public.v_raw_call_rows_deduped from anon, authenticated;
grant select on public.v_raw_call_rows_deduped to authenticated, service_role;

do $$
declare
  v text;
  old_def text;
  new_def text;
  invoker boolean;
begin
  foreach v in array array[
    'v_agent_commission',
    'v_commission_by_period',
    'v_call_centre_agent_daily',
    'v_raw_booked_daily',
    'v_portal_call_activity'
  ] loop
    old_def := pg_get_viewdef(format('public.%I', v)::regclass, true);
    new_def := replace(old_def, 'raw_call_rows r', 'v_raw_call_rows_deduped r');
    if new_def = old_def then
      raise exception '0098: % does not read raw_call_rows r; definition changed?', v;
    end if;

    select coalesce('security_invoker=on' = any (c.reloptions), false)
      into invoker
      from pg_class c
     where c.oid = format('public.%I', v)::regclass;

    execute format('create or replace view public.%I as %s', v, new_def);
    if invoker then
      execute format('alter view public.%I set (security_invoker = on)', v);
    end if;
  end loop;
end;
$$;
