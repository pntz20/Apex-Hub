/*
 * Ad sets get their real ids.
 *
 * The Fulfilment Sheet SOP pulls Ad Set ID from Windsor and reports results
 * by campaign, ad set and ad. The Hub never asked Windsor for adset_id, and
 * ads.adset_external_id was filled with the ad set NAME - so nothing could
 * join a lead's Ad Set ID (from HighLevel or the sheets) to an ad set.
 *
 * - ads.adset_name holds the name; adset_external_id now holds the real id.
 *   Existing rows are moved across here; the next windsor-ads run (7-day
 *   window, or ?days=N for history) fills adset_external_id with the id.
 * - ad_sets is the parent table, mirroring campaigns, so a dashboard can group
 *   campaign -> ad set -> ad.
 *
 * Nothing in the views reads ads.adset_external_id today, so the swap is safe.
 */

alter table public.ads add column if not exists adset_name text;

-- Old rows carry the name in the id column. Real Meta ids are all digits.
update public.ads
set adset_name = adset_external_id,
    adset_external_id = null
where adset_external_id is not null
  and adset_external_id !~ '^[0-9]+$';

create table if not exists public.ad_sets (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  campaign_id  uuid references public.campaigns (id) on delete set null,
  platform     text not null default 'meta',
  external_id  text not null,
  name         text not null,
  status       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  synced_at    timestamptz,

  unique (platform, external_id)
);

create index if not exists ad_sets_client_idx on public.ad_sets (client_id);
create index if not exists ad_sets_campaign_idx on public.ad_sets (campaign_id);
create index if not exists ads_adset_external_idx on public.ads (platform, adset_external_id);

drop trigger if exists ad_sets_set_updated_at on public.ad_sets;
create trigger ad_sets_set_updated_at
  before update on public.ad_sets
  for each row execute function public.set_updated_at();

alter table public.ad_sets enable row level security;

drop policy if exists admin_all on public.ad_sets;
create policy admin_all on public.ad_sets
  for all using (public.auth_is_admin()) with check (public.auth_is_admin());
