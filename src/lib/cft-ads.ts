/**
 * The tracker's ad set and ad breakdowns (CFT to SOP, step 17), as data.
 *
 * Reads v_cft_ad_daily (client x day x campaign x ad set x ad, see migration
 * 0099). Same rule as cft-stats: every counter is summed over the window first,
 * and only then divided.
 *
 * ============================ PARTIAL ATTRIBUTION ============================
 * Spend is attributed all the way down to the ad: every ad carries its ad set
 * id (0093). Leads and bookings are not. They carry an ad set only when
 * HighLevel's attribution does - on 28 Sep 2026, 129 of 1,460 leads and 26 of
 * 182 bookings over 30 days. The rest stay on one "Unattributed" row per
 * practice, so a practice's rows still add up to its real totals.
 *
 * That makes a cost per lead on an ad set row a trap: all of the ad set's spend
 * divided by the small share of its leads that happen to carry an id. So cost
 * figures are shown only when the practice's coverage (attributed / all, for
 * that practice over the window) reaches COVERAGE_FLOOR. Below it the cell is
 * blank and the row says how much is attributed. Rates that divide two
 * attributed counts (show %) are unaffected and always shown.
 * ============================================================================
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type AdGrain = 'adset' | 'ad';

export function isAdGrain(value: unknown): value is AdGrain {
  return value === 'adset' || value === 'ad';
}

/**
 * Coverage below which cost-per-lead and cost-per-booking are left blank.
 *
 * Half: at 50% attributed a cost per lead is at most twice the truth, which is
 * still a ranking somebody can use; at the fleet's current 9% it would be about
 * ten times the truth. Raise it once UTMs are on every ad.
 */
export const COVERAGE_FLOOR = 0.5;

export interface AdViewRow {
  client_id: string | null;
  client_name: string | null;
  group_id: string | null;
  status: string | null;
  campaign_external_id: string | null;
  campaign_name: string | null;
  adset_external_id: string | null;
  adset_name: string | null;
  ad_external_id: string | null;
  ad_name: string | null;
  spend_cents: number | null;
  impressions: number | null;
  clicks: number | null;
  leads_meta: number | null;
  leads_crm: number | null;
  bookings: number | null;
  shows: number | null;
  no_shows: number | null;
  cancels: number | null;
  revenue_cents: number | null;
}

export interface AdRow {
  key: string;
  clientId: string | null;
  groupId: string | null;
  clientName: string | null;
  status: string | null;
  campaignName: string | null;
  campaignId: string | null;
  adsetName: string | null;
  adsetId: string | null;
  /** Null at ad set grain. */
  adName: string | null;
  adId: string | null;
  /** The practice's leads and bookings that carry no ad set. */
  unattributed: boolean;

  spendCents: number;
  impressions: number;
  clicks: number;
  leadsMeta: number;
  leads: number;
  bookings: number;
  shows: number;
  noShows: number;
  cancels: number;
  revenueCents: number;

  /** Share of the practice's leads / bookings in the window that carry an ad set. */
  leadCoverage: number | null;
  bookingCoverage: number | null;
}

export interface AdDerived {
  ctr: number | null;
  cpm: number | null;
  /** Spend per CRM lead; null unless the practice's lead coverage clears the floor. */
  cpl: number | null;
  costPerBooking: number | null;
  showPct: number | null;
}

const ratio = (top: number, bottom: number): number | null => (bottom === 0 ? null : top / bottom);

export function deriveAd(row: AdRow): AdDerived {
  const dollars = row.spendCents / 100;
  const trusted = (coverage: number | null): boolean =>
    coverage !== null && coverage >= COVERAGE_FLOOR;

  return {
    ctr: ratio(row.clicks, row.impressions),
    cpm: row.impressions === 0 ? null : dollars / (row.impressions / 1000),
    cpl:
      row.unattributed || row.spendCents === 0 || !trusted(row.leadCoverage)
        ? null
        : ratio(dollars, row.leads),
    costPerBooking:
      row.unattributed || row.spendCents === 0 || !trusted(row.bookingCoverage)
        ? null
        : ratio(dollars, row.bookings),
    showPct: ratio(row.shows, row.bookings),
  };
}

export interface AdBreakdownResult {
  rows: AdRow[];
  totals: AdRow;
  /** Fleet (or filtered practice) coverage, for the note above the table. */
  leadCoverage: number | null;
  bookingCoverage: number | null;
  from: string;
  to: string;
}

const n = (value: number | null): number => value ?? 0;

function emptyRow(key: string, base: Partial<AdRow>): AdRow {
  return {
    key,
    clientId: null,
    groupId: null,
    clientName: null,
    status: null,
    campaignName: null,
    campaignId: null,
    adsetName: null,
    adsetId: null,
    adName: null,
    adId: null,
    unattributed: false,
    spendCents: 0,
    impressions: 0,
    clicks: 0,
    leadsMeta: 0,
    leads: 0,
    bookings: 0,
    shows: 0,
    noShows: 0,
    cancels: 0,
    revenueCents: 0,
    leadCoverage: null,
    bookingCoverage: null,
    ...base,
  };
}

function add(into: AdRow, row: AdViewRow): void {
  into.spendCents += n(row.spend_cents);
  into.impressions += n(row.impressions);
  into.clicks += n(row.clicks);
  into.leadsMeta += n(row.leads_meta);
  into.leads += n(row.leads_crm);
  into.bookings += n(row.bookings);
  into.shows += n(row.shows);
  into.noShows += n(row.no_shows);
  into.cancels += n(row.cancels);
  into.revenueCents += n(row.revenue_cents);
}

/**
 * The aggregation, with no database in it (exercised by npm run check:cft).
 *
 * A view row with no ad set is the practice's unattributed remainder whatever
 * its campaign, so all of a practice's unattributed leads and bookings land on
 * one row. At ad grain, a lead or booking that carries an ad set but no ad
 * lands on "(ad not recorded)" under its ad set rather than disappearing.
 */
export function aggregateAds(
  view: AdViewRow[],
  options: { grain: AdGrain; clientId?: string | undefined },
): Omit<AdBreakdownResult, 'from' | 'to'> {
  const wanted = options.clientId;
  const keep = (clientId: string | null): boolean =>
    wanted === undefined || wanted === '' || clientId === wanted;

  const byKey = new Map<string, AdRow>();
  const perClient = new Map<
    string,
    { leads: number; leadsAttr: number; bookings: number; bookingsAttr: number }
  >();

  for (const row of view) {
    if (!row.client_id || !keep(row.client_id)) continue;

    const unattributed = row.adset_external_id === null;
    const key = unattributed
      ? `${row.client_id}|unattributed`
      : options.grain === 'adset'
        ? `${row.client_id}|${row.adset_external_id}`
        : `${row.client_id}|${row.adset_external_id}|${row.ad_external_id ?? ''}`;

    const held =
      byKey.get(key) ??
      emptyRow(key, {
        clientId: row.client_id,
        groupId: row.group_id,
        clientName: row.client_name,
        status: row.status,
        unattributed,
        campaignName: unattributed ? null : row.campaign_name,
        campaignId: unattributed ? null : row.campaign_external_id,
        adsetName: unattributed ? null : row.adset_name,
        adsetId: unattributed ? null : row.adset_external_id,
        adName: unattributed || options.grain === 'adset' ? null : row.ad_name,
        adId: unattributed || options.grain === 'adset' ? null : row.ad_external_id,
      });

    // Names can be missing on the lead/booking side of a key and present on
    // the spend side; keep whichever arrives.
    if (!unattributed) {
      held.campaignName ??= row.campaign_name;
      held.campaignId ??= row.campaign_external_id;
      held.adsetName ??= row.adset_name;
      if (options.grain === 'ad') held.adName ??= row.ad_name;
    }

    add(held, row);
    byKey.set(key, held);

    const c = perClient.get(row.client_id) ?? {
      leads: 0,
      leadsAttr: 0,
      bookings: 0,
      bookingsAttr: 0,
    };
    c.leads += n(row.leads_crm);
    c.bookings += n(row.bookings);
    if (!unattributed) {
      c.leadsAttr += n(row.leads_crm);
      c.bookingsAttr += n(row.bookings);
    }
    perClient.set(row.client_id, c);
  }

  for (const row of byKey.values()) {
    const c = row.clientId ? perClient.get(row.clientId) : undefined;
    row.leadCoverage = c ? ratio(c.leadsAttr, c.leads) : null;
    row.bookingCoverage = c ? ratio(c.bookingsAttr, c.bookings) : null;
  }

  // A practice's rows together, biggest spender first; within a practice by
  // spend, with the unattributed remainder last.
  const clientSpend = new Map<string, number>();
  for (const row of byKey.values()) {
    if (row.clientId) {
      clientSpend.set(row.clientId, (clientSpend.get(row.clientId) ?? 0) + row.spendCents);
    }
  }
  const rows = [...byKey.values()].sort((a, b) => {
    const byClient =
      (clientSpend.get(b.clientId ?? '') ?? 0) - (clientSpend.get(a.clientId ?? '') ?? 0);
    if (byClient !== 0) return byClient;
    if (a.clientId !== b.clientId) return (a.clientName ?? '').localeCompare(b.clientName ?? '');
    if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
    return b.spendCents - a.spendCents;
  });

  const totals = emptyRow('__totals__', {});
  let leadsAttr = 0;
  let bookingsAttr = 0;
  for (const row of rows) {
    totals.spendCents += row.spendCents;
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.leadsMeta += row.leadsMeta;
    totals.leads += row.leads;
    totals.bookings += row.bookings;
    totals.shows += row.shows;
    totals.noShows += row.noShows;
    totals.cancels += row.cancels;
    totals.revenueCents += row.revenueCents;
    if (!row.unattributed) {
      leadsAttr += row.leads;
      bookingsAttr += row.bookings;
    }
  }
  const leadCoverage = ratio(leadsAttr, totals.leads);
  const bookingCoverage = ratio(bookingsAttr, totals.bookings);
  totals.leadCoverage = leadCoverage;
  totals.bookingCoverage = bookingCoverage;

  return { rows, totals, leadCoverage, bookingCoverage };
}

const PAGE = 1000;

export async function loadAdBreakdown(
  db: SupabaseClient,
  options: {
    from: string;
    to: string;
    grain: AdGrain;
    clientId?: string | undefined;
  },
): Promise<AdBreakdownResult> {
  const view: AdViewRow[] = [];
  for (let page = 0; ; page += 1) {
    let query = db
      .from('v_cft_ad_daily')
      .select(
        'client_id, client_name, group_id, status, campaign_external_id, campaign_name, adset_external_id, adset_name, ad_external_id, ad_name, spend_cents, impressions, clicks, leads_meta, leads_crm, bookings, shows, no_shows, cancels, revenue_cents',
      )
      .gte('day', options.from)
      .lte('day', options.to);
    if (options.clientId) query = query.eq('client_id', options.clientId);
    // A stable order, or paging can skip or repeat rows between pages.
    query = query
      .order('day')
      .order('client_id')
      .order('campaign_external_id', { nullsFirst: true })
      .order('adset_external_id', { nullsFirst: true })
      .order('ad_external_id', { nullsFirst: true });
    const { data, error } = await query.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as AdViewRow[];
    view.push(...batch);
    if (batch.length < PAGE) break;
  }

  return { ...aggregateAds(view, options), from: options.from, to: options.to };
}
