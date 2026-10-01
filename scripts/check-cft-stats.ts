/**
 * Exercise the Client Fulfilment Tracker aggregation.
 *
 * This decides what numbers Josh reads instead of opening the spreadsheet, so
 * the cases pinned here are the ones where a plausible implementation is wrong
 * rather than the ones that are obviously right:
 *
 *   - ratios computed from summed counters, never averaged across days
 *   - the two feeds unioned by client, not left-joined from the ad side
 *   - call columns ABSENT at campaign grain, not zero and not repeated
 *   - totals recomputed from the summed counters, not summed from row ratios
 *   - a zero denominator giving blank, not zero
 *
 *   npm run check:cft
 *
 * No database, no network, no sheet.
 */
import { COLUMNS, LETTERS, SECTIONS } from '../src/lib/cft-columns';
import {
  type CallViewRow,
  type StatsViewRow,
  aggregate,
  derive,
  offerFromCampaign,
  sortRows,
  windowFor,
} from '../src/lib/cft-stats';
import { type AdViewRow, aggregateAds, deriveAd } from '../src/lib/cft-ads';

let failures = 0;
let checks = 0;

function check(what: string, actual: unknown, expected: unknown) {
  checks += 1;
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok    ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${what}`);
  console.log(`        expected ${JSON.stringify(expected)}`);
  console.log(`        actual   ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

function stat(over: Partial<StatsViewRow> = {}): StatsViewRow {
  return {
    client_id: 'c1',
    group_id: 'g1',
    client_name: 'Bright Smile',
    status: 'Active',
    campaign_name: 'Implants',
    campaign_id_external: '111',
    offer_name: 'Free consult',
    spend_cents: 0,
    leads_best: 0,
    appts_created: 0,
    appts_tracker: 0,
    appts_to_be_taken: 0,
    last_appt_date: null,
    shows: 0,
    no_shows: 0,
    cancels: 0,
    dqs: 0,
    closes: 0,
    revenue_cents: 0,
    showed_other: 0,
    rescheduled: 0,
    deposits_paid: 0,
    ...over,
  };
}

function call(over: Partial<CallViewRow> = {}): CallViewRow {
  return {
    client_id: 'c1',
    group_id: 'g1',
    client_name: 'Bright Smile',
    dialed_calls: 0,
    calls_2min: 0,
    calls_2min_outbound: 0,
    connected_outbound: 0,
    answered_outbound: 0,
    connected_but_silent: 0,
    speed_to_lead_min_sum: 0,
    speed_to_lead_n: 0,
    speed_to_lead_over_24h: 0,
    ...over,
  };
}

const campaign = { breakdown: 'campaign' as const };
const client = { breakdown: 'client' as const };

// ---------------------------------------------------------------------------

section('Aggregate first, then divide');

/*
 * The whole contract in one case. Two days: one with 1 lead at $100 spend, one
 * with 99 leads at $100 spend. The right CPL is 200/100 = $2.00.
 *
 * Averaging the daily CPLs gives (100 + 1.01) / 2 = $50.51 — twenty-five times
 * too high, and entirely plausible-looking on a page.
 */
const lopsided = aggregate(
  [
    stat({ spend_cents: 10_000, leads_best: 1 }),
    stat({ spend_cents: 10_000, leads_best: 99 }),
  ],
  [],
  campaign,
);

check('two days collapse to one campaign row', lopsided.rows.length, 1);
check(
  'CPL is total spend over total leads, not the mean of daily CPLs',
  derive(lopsided.rows[0]!).cpl,
  2,
);

check(
  'Show % is total shows over total appointments',
  derive(
    aggregate(
      [
        stat({ appts_created: 1, shows: 1 }),
        stat({ appts_created: 99, shows: 0 }),
      ],
      [],
      campaign,
    ).rows[0]!,
  ).showPct,
  0.01,
);

section('A zero denominator is blank, not zero');

const spendNoLeads = aggregate([stat({ spend_cents: 50_000 })], [], campaign);
const d = derive(spendNoLeads.rows[0]!);

check('CPL with no leads', d.cpl, null);
check('Schedule % with no leads', d.schedulePct, null);

/*
 * Schedule % must divide the TRACKER appointments by leads, not all of them.
 *
 * There was no positive assertion on this column - only the null-denominator
 * case above - which is how it shipped reading 121.3% across the fleet. Ledger
 * appointments carry no campaign, no spend and no lead, so counting them here
 * divides two different questions. See migration 0075.
 */
const mixedAppts = aggregate(
  [stat({ leads_best: 20, appts_created: 10, appts_tracker: 6 })],
  [],
  campaign,
);
check(
  'Schedule % counts tracker appointments only',
  derive(mixedAppts.rows[0]!).schedulePct,
  6 / 20,
);
check(
  'and Show % still divides by every appointment',
  derive(aggregate([stat({ appts_created: 10, appts_tracker: 6, shows: 5 })], [], campaign).rows[0]!).showPct,
  5 / 10,
);
check('Show % with no appointments', d.showPct, null);
check('Close % with no shows', d.closePct, null);
check('Cost Per Show with no shows', d.costPerShow, null);
// The spend is real and still shown; only the ratios are unknowable.
check('the spend itself is kept', spendNoLeads.rows[0]!.spendCents, 50_000);

section('Call data is apportioned across a practice\'s campaigns by lead share');

const withCalls = aggregate(
  [
    stat({ campaign_id_external: '111', spend_cents: 1000, leads_best: 10 }),
    stat({ campaign_id_external: '222', spend_cents: 1000, leads_best: 10 }),
  ],
  [call({ dialed_calls: 80, calls_2min: 8, connected_outbound: 79 })],
  campaign,
);

check('two campaigns for one client stay two rows', withCalls.rows.length, 2);
/*
 * Apportioned, not repeated and not absent. Repeating the client's 80 dials
 * on both rows would report 160 dials for 80 calls; hatching them out left a
 * tracker with no call data on its default view. Two campaigns with ten
 * leads each split the 80 dials 40 and 40, and the rows sum to the truth.
 */
check(
  'each campaign row carries its lead-share of the calls',
  withCalls.rows.map((row) => row.calls?.dialed),
  [40, 40],
);
check(
  'so Dials per Lead is the practice\'s own figure on every row',
  withCalls.rows.map((row) => derive(row).dialsPerLead),
  [4, 4],
);
check('and the rows sum back to the real total', withCalls.totals.calls?.dialed, 80);
const unevenCalls = aggregate(
  [
    stat({ campaign_id_external: '111', spend_cents: 1000, leads_best: 7 }),
    stat({ campaign_id_external: '222', spend_cents: 1000, leads_best: 3 }),
  ],
  [call({ dialed_calls: 11 })],
  campaign,
);
check(
  'largest-remainder rounding: 11 dials over 7:3 leads is 8 and 3',
  unevenCalls.rows.map((row) => row.calls?.dialed),
  [8, 3],
);

section('But the window total is answerable at either breakdown');

/*
 * The distinction this section defends.
 *
 * "How many calls did this campaign make" has no answer — that is the section
 * above. "How many calls happened in this window" has one, and it is the same
 * number whichever way the table is broken down, because the calls are summed
 * once rather than divided.
 *
 * Worth pinning because the campaign breakdown is the DEFAULT. Six blank
 * columns under a heading reading "2. CALL DATA" was being read as "the Hub has
 * no call data", when there are 7,139 calls in it.
 */
const callsAtCampaign = aggregate(
  [stat({ campaign_id_external: '111' }), stat({ campaign_id_external: '222' })],
  [call({ dialed_calls: 80, calls_2min: 8, connected_outbound: 79 })],
  campaign,
);
const callsAtClient = aggregate(
  [stat({ campaign_id_external: '111' }), stat({ campaign_id_external: '222' })],
  [
    call({
      dialed_calls: 80,
      calls_2min: 8,
      // Six of the eight long calls were ours; two were inbound.
      calls_2min_outbound: 6,
      connected_outbound: 79,
      // Talk time on 40 of the 80. The gap from connected_outbound is the
      // point: 39 of those 79 'connected' calls had nobody on the line.
      answered_outbound: 40,
    }),
  ],
  client,
);

check('the window total survives campaign grain', callsAtCampaign.callTotals.dialed, 80);
check('and is identical at client grain', callsAtClient.callTotals.dialed, 80);
// Counted once, not once per campaign row — the mistake the row-level
// blocking exists to prevent, reappearing one level up.
check(
  'two campaign rows do not double it',
  callsAtCampaign.callTotals.dialed,
  callsAtClient.callTotals.dialed,
);
check('2-minute calls come through too', callsAtCampaign.callTotals.calls2min, 8);
check(
  'and connected, for pickup %',
  callsAtCampaign.callTotals.connectedOutbound,
  79,
);

// Summed across clients, so several practices add up.
const twoClients = aggregate(
  [],
  [
    call({ client_id: 'c1', dialed_calls: 30 }),
    call({ client_id: 'c2', client_name: 'Harbour Dental', dialed_calls: 12 }),
  ],
  campaign,
);
check('clients sum', twoClients.callTotals.dialed, 42);

// Same day, two rows: the view is daily, so a 30-day window has 30 of them.
const twoDays = aggregate(
  [],
  [call({ dialed_calls: 5 }), call({ dialed_calls: 7 })],
  campaign,
);
check('days sum', twoDays.callTotals.dialed, 12);

// The client filter has to narrow this too, or picking one practice would
// show its campaigns beside everybody's calls.
const filteredCalls = aggregate(
  [],
  [
    call({ client_id: 'c1', dialed_calls: 30 }),
    call({ client_id: 'c2', client_name: 'Harbour Dental', dialed_calls: 12 }),
  ],
  { breakdown: 'campaign' as const, clientId: 'c2' },
);
check('the client filter narrows it', filteredCalls.callTotals.dialed, 12);

// No calls at all is zero, not a crash — and zero is a real answer here,
// unlike at row level where absent was the honest one.
check('no calls is zero', aggregate([stat()], [], campaign).callTotals.dialed, 0);

section('Offer name from the campaign name');
check('price segment', offerFromCampaign('Apex | $3997 Total Price | LP'), '$3997 Total Price');
check('discount with emoji', offerFromCampaign('🟢  [Landing Page] Conversion | Apex | $2000 Off'), '$2000 Off');
check('drops "- Copy"', offerFromCampaign('Apex | Hancock | $3497 Total Price for Invisalign - Copy'), '$3497 Total Price for Invisalign');
check('treatment when no price', offerFromCampaign('Apex | Clear Aligners | LP'), 'Clear Aligners');
check('placeholder stays blank', offerFromCampaign('Apex | Conversion | $xxxx OFF'), null);
check('no offer stays blank', offerFromCampaign('Apex | The Smile Lounge | LP'), null);
check(
  'sheet offer wins over the campaign name',
  aggregate([stat({ offer_name: 'Free consult', campaign_name: 'Apex | $1500 Off' })], [], campaign).rows[0]!.offerName,
  'Free consult',
);
check(
  'blank sheet offer falls back to the campaign name',
  aggregate([stat({ offer_name: null, campaign_name: 'Apex | $1500 Off' })], [], campaign).rows[0]!.offerName,
  '$1500 Off',
);

section('Revenue and ROI (stat-sheet treatment value, 0095)');
const valued = aggregate(
  [stat({ spend_cents: 100_000, revenue_cents: 350_000 }), stat({ spend_cents: 50_000, revenue_cents: 100_000 })],
  [],
  campaign,
);
check('revenue sums across the window', valued.totals.revenueCents, 450_000);
check('ROI is revenue over spend', derive(valued.totals).roi, 3);
check(
  'no revenue recorded is blank, not 0.00x',
  derive(aggregate([stat({ spend_cents: 100_000 })], [], campaign).rows[0]!).roi,
  null,
);
check(
  'revenue with no spend is blank, not infinite',
  derive(aggregate([stat({ revenue_cents: 100_000 })], [], campaign).rows[0]!).roi,
  null,
);

/*
 * A zero-second call is not a pickup.
 *
 * GoHighLevel says 'completed' when a call attempt finishes, not when somebody
 * answers, and sync/crm-calls maps that to 'connected'. Over the 30 days to
 * 7 September it made 2,233 of 2,270 outbound dials look connected — 98.4% —
 * while 1,299 of them had no talk time. These numbers are that shape, scaled
 * down, so the two definitions cannot quietly converge again.
 */
const silentDials = aggregate(
  [],
  [
    call({
      dialed_calls: 100,
      connected_outbound: 98,
      answered_outbound: 41,
      connected_but_silent: 57,
    }),
  ],
  campaign,
);
check(
  'the status word still reports its inflated figure',
  silentDials.callTotals.connectedOutbound,
  98,
);
check('talk time reports the real one', silentDials.callTotals.answeredOutbound, 41);
check('and the gap is carried, not hidden', silentDials.callTotals.connectedButSilent, 57);
// The card divides by dialed, so this is the number a reader sees.
check(
  'answered % is the one worth showing',
  Math.round((silentDials.callTotals.answeredOutbound / silentDials.callTotals.dialed) * 1000) / 10,
  41,
);
check(
  'and it is not what the status word would have shown',
  silentDials.callTotals.connectedOutbound === silentDials.callTotals.answeredOutbound,
  false,
);
check(
  'and its speed-to-lead denominator is zero, so the ratio is blank not zero',
  aggregate([stat()], [], campaign).callTotals.speedToLeadN,
  0,
);

const byClient = aggregate(
  [
    stat({ campaign_id_external: '111', spend_cents: 1000, leads_best: 10 }),
    stat({ campaign_id_external: '222', spend_cents: 1000, leads_best: 10 }),
  ],
  [
    call({
      dialed_calls: 80,
      calls_2min: 8,
      // Six of the eight long calls were ours; two were inbound.
      calls_2min_outbound: 6,
      connected_outbound: 79,
      // Talk time on 40 of the 80. The gap from connected_outbound is the
      // point: 39 of those 79 'connected' calls had nobody on the line.
      answered_outbound: 40,
    }),
  ],
  client,
);

check('the client breakdown is one row', byClient.rows.length, 1);
check('and it carries the calls once', byClient.rows[0]!.calls?.dialed, 80);
/*
 * Talk time, not GoHighLevel's status word. Asserting the OLD definition here
 * is what caught the change, which is the test doing its job - so this asserts
 * the new one explicitly rather than being loosened.
 */
check(
  'Pickup % is answered outbound over dialed, not connected',
  derive(byClient.rows[0]!).pickupPct,
  40 / 80,
);
check(
  'Conversation % counts only outbound long calls',
  derive(byClient.rows[0]!).conversationPct,
  6 / 80,
);
check(
  'Dials per Lead spans both campaigns of that client',
  derive(byClient.rows[0]!).dialsPerLead,
  4,
);

section('The two feeds are unioned, not joined');

/*
 * Eight of forty-two clients have call activity and no ad spend over a thirty
 * day window. A left join from the stats side drops them and the client count
 * silently disagrees with the sheet.
 */
const unioned = aggregate(
  [stat({ client_id: 'c1', spend_cents: 1000 })],
  [
    call({ client_id: 'c1', dialed_calls: 10 }),
    call({ client_id: 'c2', client_name: 'Harbour Dental', dialed_calls: 25 }),
  ],
  client,
);

check('the call-only client gets a row', unioned.rows.length, 2);
check(
  'with its calls and no spend',
  unioned.rows
    .map((row) => [row.clientName, row.spendCents, row.calls?.dialed])
    .sort(),
  [
    ['Bright Smile', 1000, 10],
    ['Harbour Dental', 0, 25],
  ],
);
check(
  'and it appears in the client filter',
  unioned.clients.map((entry) => entry.name),
  ['Bright Smile', 'Harbour Dental'],
);

section('Appointments with no campaign keep their own row');

// 118 of 1,281 tracker appointments carry no campaign id. They are real
// appointments; folding them into a named campaign would misattribute them.
const noCampaign = aggregate(
  [
    stat({ campaign_id_external: '111', campaign_name: 'Implants', appts_created: 3 }),
    stat({ campaign_id_external: null, campaign_name: null, appts_created: 2 }),
  ],
  [],
  campaign,
);

check('they are not filtered out', noCampaign.rows.length, 2);
check(
  'and not merged into a named campaign',
  noCampaign.rows.map((row) => [row.campaignName, row.apptsCreated]).sort(),
  [
    [null, 2],
    ['Implants', 3],
  ],
);

section('Totals are recomputed, never summed from the rows');

/*
 * Three campaigns, wildly different volumes. The totals row must divide the
 * summed counters — adding the three CPLs, or averaging them, both give a
 * figure that is not the cost per lead of anything.
 */
const many = aggregate(
  [
    stat({ campaign_id_external: 'a', spend_cents: 10_000, leads_best: 1, appts_created: 1, shows: 1 }),
    stat({ campaign_id_external: 'b', spend_cents: 10_000, leads_best: 99, appts_created: 10, shows: 2 }),
    stat({ campaign_id_external: 'c', spend_cents: 30_000, leads_best: 400, appts_created: 40, shows: 20 }),
  ],
  [],
  campaign,
);

check('the counters add up', [many.totals.spendCents, many.totals.leads, many.totals.shows], [50_000, 500, 23]);
check('total CPL divides the sums', derive(many.totals).cpl, 500 / 500);
check('total Show % divides the sums', derive(many.totals).showPct, 23 / 51);
// The mean of the three rows' Show % is 0.617; the true figure is 0.451.
check(
  'which is not the mean of the row percentages',
  Math.abs(derive(many.totals).showPct! - 0.617) > 0.15,
  true,
);

check(
  'rows sort by spend, descending',
  many.rows.map((row) => row.spendCents),
  [30_000, 10_000, 10_000],
);

section('Last Appt Date is a maximum, not a sum');

check(
  'the latest date across the window wins',
  aggregate(
    [
      stat({ last_appt_date: '2026-08-11' }),
      stat({ last_appt_date: '2026-08-29' }),
      stat({ last_appt_date: null }),
    ],
    [],
    campaign,
  ).rows[0]!.lastApptDate,
  '2026-08-29',
);

section('The client filter');

const filtered = aggregate(
  [
    stat({ client_id: 'c1', spend_cents: 1000 }),
    stat({ client_id: 'c2', client_name: 'Harbour Dental', spend_cents: 9000 }),
  ],
  [call({ client_id: 'c2', client_name: 'Harbour Dental', dialed_calls: 40 })],
  { ...client, clientId: 'c2' },
);

check('narrows the rows', filtered.rows.map((row) => row.clientName), ['Harbour Dental']);
check('and the totals', filtered.totals.spendCents, 9000);
check('and the calls with them', filtered.totals.calls?.dialed, 40);
// The picker still lists everybody, or you could not switch back.
check('but not the client list', filtered.clients.length, 2);

section('The window');

check(
  'three days is inclusive of today',
  windowFor(3, new Date('2026-09-04T12:00:00Z')),
  { from: '2026-09-02', to: '2026-09-04' },
);
check(
  'thirty days ending 4 September is the verification window',
  windowFor(30, new Date('2026-09-04T12:00:00Z')),
  { from: '2026-08-06', to: '2026-09-04' },
);

section('Empty input');

const nothing = aggregate([], [], campaign);
check('no rows', nothing.rows.length, 0);
check('totals are zero rather than absent', nothing.totals.spendCents, 0);
check('and its CPL is blank', derive(nothing.totals).cpl, null);

section('The column model matches the sheet');

check('the sheet\x27s thirty-three columns plus three for outcome detail', COLUMNS.length, 36);
check('lettered A to AJ in order', COLUMNS.map((c) => c.letter), LETTERS);
check('the sheet\x27s own letters still end at AG', LETTERS[32], 'AG');
check('and the outcome detail is AH to AJ', LETTERS.slice(33), ['AH', 'AI', 'AJ']);
check(
  'the section headers span every column',
  SECTIONS.reduce((total, s) => total + s.span, 0),
  36,
);
check(
  'the sections are the sheet\x27s, in order, then outcome detail',
  SECTIONS.map((s) => s.label),
  ['', 'CAMPAIGN INFORMATION', '1. AD DATA', '2. CALL DATA', '3. APPOINTMENT DATA', '4. DEALS', '5. KPI METRICS', '6. OUTCOME DETAIL'],
);
/*
 * Two separate reasons, one hatching.
 *
 * J to O are the call block: the calls table carries no campaign reference at
 * all, so those figures cannot be known per campaign.
 *
 * H, I, P to AB and AE to AG come from the tracker sheet, which DOES carry a
 * campaign id per row and gets it wrong - every campaign id is cited by leads
 * from 3 to 29 different practices. Those columns are real at client grain and
 * meaningless at campaign grain.
 *
 * This assertion had not been updated when the second group was blocked, so it
 * had been failing quietly ever since. Listed in full rather than counted, so
 * the next person to block or unblock a column has to say so here.
 */
check(
  'nothing is blocked in a campaign breakdown any more (0088 and lead-share calls)',
  COLUMNS.filter((c) => c.blockedAt?.('campaign')).map((c) => c.letter),
  [],
);
check(
  'and none of them are blocked at client grain',
  COLUMNS.filter((c) => c.blockedAt?.('client')).length,
  0,
);
check(
  'only Notes has no Hub source (Revenue and ROI come from the stat sheets, 0095)',
  COLUMNS.filter((c) => c.noSource).map((c) => c.letter),
  ['A'],
);

section('Sorting');

const forSort = [
  { n: 3 as number | string | null },
  { n: 1 },
  { n: 2 },
];

check(
  'descending is the default direction',
  sortRows(forSort, (r) => r.n, 'desc').map((r) => r.n),
  [3, 2, 1],
);
check(
  'ascending reverses it',
  sortRows(forSort, (r) => r.n, 'asc').map((r) => r.n),
  [1, 2, 3],
);

/*
 * Blanks sink in BOTH directions. A campaign with no leads has no CPL, and
 * letting null sort as zero parks every unmeasurable row at the top of
 * "cheapest cost per lead" — the most expensive misreading available on a page
 * somebody scans to decide where to put money.
 */
const withBlanks = [{ n: 2 as number | null }, { n: null }, { n: 1 }];
check(
  'blanks sink when sorting ascending',
  sortRows(withBlanks, (r) => r.n, 'asc').map((r) => r.n),
  [1, 2, null],
);
check(
  'and when sorting descending',
  sortRows(withBlanks, (r) => r.n, 'desc').map((r) => r.n),
  [2, 1, null],
);
check(
  'text sorts as text, not by code point accident',
  sortRows([{ n: 'b' as string }, { n: 'A' }, { n: 'c' }], (r) => r.n, 'asc').map((r) => r.n),
  ['A', 'b', 'c'],
);
// Sorting reads the value, not the rendered string: 9 must sit below 10.
check(
  'numbers sort numerically',
  sortRows([{ n: 9 as number }, { n: 10 }, { n: 100 }], (r) => r.n, 'asc').map((r) => r.n),
  [9, 10, 100],
);

// ---------------------------------------------------------------------------
// Ad set / ad breakdown (0099). Partial attribution is the case that matters:
// a practice's rows must still add up, and a cost must not be divided over
// the few leads that happen to carry an id.

console.log('\nad set / ad breakdown');

const adRow = (over: Partial<AdViewRow>): AdViewRow => ({
  client_id: 'c1',
  client_name: 'Practice',
  group_id: 'g1',
  status: 'Active',
  campaign_external_id: 'cmp1',
  campaign_name: 'Campaign',
  adset_external_id: 'as1',
  adset_name: 'Ad set 1',
  ad_external_id: 'ad1',
  ad_name: 'Ad 1',
  spend_cents: 0,
  impressions: 0,
  clicks: 0,
  leads_meta: 0,
  leads_crm: 0,
  bookings: 0,
  shows: 0,
  no_shows: 0,
  cancels: 0,
  revenue_cents: 0,
  ...over,
});

const adView: AdViewRow[] = [
  // Two days of spend on ad set 1 (two ads) and ad set 2.
  adRow({ spend_cents: 10000, impressions: 1000, clicks: 10 }),
  adRow({ ad_external_id: 'ad2', ad_name: 'Ad 2', spend_cents: 5000, impressions: 500, clicks: 5 }),
  adRow({ adset_external_id: 'as2', adset_name: 'Ad set 2', ad_external_id: 'ad3', spend_cents: 20000 }),
  // Attributed leads and bookings: 2 leads on as1 with no ad id, 1 booking that showed.
  adRow({ ad_external_id: null, ad_name: null, leads_crm: 2, bookings: 1, shows: 1 }),
  // Unattributed: 8 leads, 3 bookings.
  adRow({ campaign_external_id: null, adset_external_id: null, adset_name: null, ad_external_id: null, ad_name: null, leads_crm: 8, bookings: 3 }),
];

const bySet = aggregateAds(adView, { grain: 'adset' });
check('ad set grain: one row per ad set plus one unattributed', bySet.rows.length, 3);
check('unattributed row sorts last within the practice', bySet.rows.at(-1)?.unattributed, true);
check('totals keep every lead, attributed or not', bySet.totals.leads, 10);
check('totals keep every booking', bySet.totals.bookings, 4);
check('lead coverage is attributed / all', bySet.leadCoverage, 0.2);
const as1 = bySet.rows.find((r) => r.adsetId === 'as1')!;
check('ad set 1 sums both its ads', as1.spendCents, 15000);
check('CPL blank below the coverage floor (20% attributed)', deriveAd(as1).cpl, null);
check('show % still shown (attributed / attributed)', deriveAd(as1).showPct, 1);
check('CTR from summed counters', deriveAd(as1).ctr, 15 / 1500);

const covered = aggregateAds(
  adView.filter((r) => r.adset_external_id !== null),
  { grain: 'adset' },
);
const as1Covered = covered.rows.find((r) => r.adsetId === 'as1')!;
check('CPL shown once coverage clears the floor', deriveAd(as1Covered).cpl, 150 / 2);

const byAd = aggregateAds(adView, { grain: 'ad' });
check(
  'ad grain: leads with an ad set but no ad land on their own row',
  byAd.rows.some((r) => r.adsetId === 'as1' && r.adId === null && r.leads === 2),
  true,
);
check('ad grain keeps the same totals', [byAd.totals.leads, byAd.totals.spendCents], [10, 35000]);
check(
  'client filter drops other practices',
  aggregateAds([...adView, adRow({ client_id: 'c2', spend_cents: 999 })], { grain: 'adset', clientId: 'c1' }).totals.spendCents,
  35000,
);

section('Step 10: matched calls go to their campaign, the rest by lead share');
{
  const rows = [
    stat({ campaign_id_external: '111', leads_best: 1 }),
    stat({ campaign_id_external: '222', campaign_name: 'Braces', leads_best: 3 }),
  ];
  const dials = [call({ dialed_calls: 100, calls_2min: 8 })];
  const matched = [
    { client_id: 'c1', campaign_external_id: '111', day: '2026-09-20', dialed_calls: 40, calls_2min: 6, calls_2min_outbound: 0, connected_outbound: 0, answered_outbound: 0, connected_but_silent: 0 },
  ];
  const result = aggregate(rows, dials, campaign, matched);
  const byId = new Map(result.rows.map((r) => [r.campaignId, r]));
  // 60 unmatched split 1:3 -> 15 / 45; campaign 111 also gets its 40 matched.
  check('matched campaign gets its own calls plus its share', byId.get('111')!.calls!.dialed, 55);
  check('the other campaign gets only its share', byId.get('222')!.calls!.dialed, 45);
  check('rows still sum to the practice total', byId.get('111')!.calls!.dialed + byId.get('222')!.calls!.dialed, 100);
  check('long calls follow the same rule', byId.get('111')!.calls!.calls2min + byId.get('222')!.calls!.calls2min, 8);
  const over = aggregate(rows, [call({ dialed_calls: 10 })], campaign, [{ ...matched[0]!, dialed_calls: 25 }]);
  check('a match never claims more than the practice has', over.rows.reduce((t, r) => t + (r.calls?.dialed ?? 0), 0), 10);
  check('and nothing goes negative', over.rows.every((r) => (r.calls?.dialed ?? 0) >= 0), true);
  check('without matches it is the old lead-share split', aggregate(rows, dials, campaign).rows.find((r) => r.campaignId === '111')!.calls!.dialed, 25);
}

section('Outcome detail (step 14) sums like the other counters');
{
  const both = aggregate(
    [
      stat({ showed_other: 2, rescheduled: 1, deposits_paid: 3 }),
      stat({ campaign_id_external: '222', campaign_name: 'Braces', showed_other: 1, rescheduled: 4, deposits_paid: 0 }),
    ],
    [],
    { ...campaign, breakdown: 'client' },
  );
  check('showed - other summed per practice', both.rows[0]!.showedOther, 3);
  check('rescheduled summed per practice', both.rows[0]!.rescheduled, 5);
  check('deposit paid summed per practice', both.rows[0]!.depositsPaid, 3);
  check('totals carry them too', [both.totals.showedOther, both.totals.rescheduled, both.totals.depositsPaid], [3, 5, 3]);
}

// ---------------------------------------------------------------------------

console.log(
  failures === 0
    ? `\n${checks}/${checks} checks passed`
    : `\n${failures} of ${checks} checks FAILED`,
);

process.exit(failures === 0 ? 0 : 1);
