/*
 * Leads and bookings carry their ad set.
 *
 * The Fulfilment Sheet SOP stamps Campaign ID, Ad Set ID and Ad ID on every
 * lead from HighLevel's contact.attributionSource. The Hub read only
 * contact.attributions[0] and had nowhere to put an ad set id, so the chain
 * ad -> ad set -> campaign stopped at the campaign.
 *
 * ghl.ts now reads attributionSource first (what the SOP uses), then
 * attributions[0], then lastAttributionSource, and fills these columns.
 */

alter table public.appointments add column if not exists adset_external_id text;
alter table public.crm_leads    add column if not exists adset_external_id text;

create index if not exists appointments_adset_idx
  on public.appointments (adset_external_id)
  where adset_external_id is not null;

create index if not exists crm_leads_adset_idx
  on public.crm_leads (adset_external_id)
  where adset_external_id is not null;
