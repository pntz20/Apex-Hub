import Link from 'next/link';

import { type AdGrain, type AdRow, COVERAGE_FLOOR, deriveAd } from '@/lib/cft-ads';
import { cn } from '@/lib/cn';
import { formatCount, formatMoney, formatPercent } from '@/lib/format';

/**
 * The tracker by ad set or by ad (CFT to SOP, step 17).
 *
 * Deliberately NOT the 33-column sheet mirror. The STATS DASHBOARD tab has no
 * ad set or ad grain to mirror letter for letter, and call data cannot be split
 * below the practice at all. So this is its own, shorter table: ad data first,
 * then the leads and bookings HighLevel attributes to each ad set or ad.
 *
 * Cost figures follow COVERAGE_FLOOR (lib/cft-ads): blank, with the reason on
 * hover, when too little of the practice's leads or bookings carry an ad set
 * for a cost per lead to mean anything.
 */

const money2 = (dollars: number | null): string =>
  dollars === null
    ? '—'
    : dollars.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      });

function Cell({
  children,
  align = 'right',
  className,
  title,
}: {
  children?: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
  title?: string | undefined;
}) {
  return (
    <td
      title={title}
      className={cn(
        'whitespace-nowrap border-b border-line px-2 py-1.5',
        align === 'right' ? 'numeric text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}

function coverageNote(kind: 'leads' | 'bookings', coverage: number | null): string {
  return coverage === null
    ? `No ${kind} for this practice in the window.`
    : `Only ${formatPercent(coverage, 0)} of this practice's ${kind} carry an ad set, so a cost here would count all the spend against that share. Shown from ${formatPercent(COVERAGE_FLOOR, 0)}.`;
}

export function AdBreakdownTable({
  rows,
  totals,
  grain,
}: {
  rows: AdRow[];
  totals: AdRow;
  grain: AdGrain;
}) {
  const headings = [
    'Client',
    'Campaign',
    'Ad set',
    ...(grain === 'ad' ? ['Ad'] : []),
    'Spend',
    'Impr.',
    'Clicks',
    'CTR',
    'CPM',
    'Meta leads',
    'Leads',
    'CPL',
    'Bookings',
    'Cost / booking',
    'Shows',
    'Show %',
    'Revenue',
  ];
  const leftCount = grain === 'ad' ? 4 : 3;
  const t = deriveAd(totals);

  let previousClient: string | null = null;

  return (
    <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
      <thead>
        <tr>
          {headings.map((heading, index) => (
            <th
              key={heading}
              className={cn(
                'sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-subtle',
                index < leftCount ? 'text-left' : 'text-right',
              )}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const d = deriveAd(row);
          const firstOfClient = row.clientId !== previousClient;
          previousClient = row.clientId;
          const blank = row.unattributed;

          return (
            <tr key={row.key} className={cn('hover:bg-surface-hover', blank && 'text-fg-muted')}>
              {/* The practice name once per block; its other rows stay quiet. */}
              <Cell
                align="left"
                className={cn(
                  firstOfClient ? 'font-medium text-fg' : 'text-transparent',
                  firstOfClient && 'border-t border-t-line-strong',
                )}
              >
                {row.groupId && firstOfClient ? (
                  <Link href={`/clients/${row.groupId}`} className="hover:underline">
                    {row.clientName ?? '—'}
                  </Link>
                ) : (
                  (row.clientName ?? '—')
                )}
              </Cell>
              <Cell
                align="left"
                className="max-w-[220px] truncate"
                title={row.campaignName ?? undefined}
              >
                {blank ? '' : (row.campaignName ?? row.campaignId ?? '(no campaign)')}
              </Cell>
              <Cell
                align="left"
                className="max-w-[240px] truncate"
                title={
                  blank
                    ? `No ad set recorded: ${formatPercent(
                        row.leadCoverage === null ? null : 1 - row.leadCoverage,
                        0,
                      )} of this practice's leads and ${formatPercent(
                        row.bookingCoverage === null ? null : 1 - row.bookingCoverage,
                        0,
                      )} of its bookings`
                    : (row.adsetId ?? undefined)
                }
              >
                {blank ? (
                  <span className="italic">Unattributed leads &amp; bookings</span>
                ) : (
                  (row.adsetName ?? row.adsetId ?? '—')
                )}
              </Cell>
              {grain === 'ad' ? (
                <Cell align="left" className="max-w-[240px] truncate" title={row.adId ?? undefined}>
                  {blank ? '' : (row.adName ?? row.adId ?? '(ad not recorded)')}
                </Cell>
              ) : null}
              <Cell>{blank ? '' : formatMoney(row.spendCents)}</Cell>
              <Cell>{blank ? '' : formatCount(row.impressions)}</Cell>
              <Cell>{blank ? '' : formatCount(row.clicks)}</Cell>
              <Cell>{blank ? '' : formatPercent(d.ctr, 2)}</Cell>
              <Cell>{blank ? '' : money2(d.cpm)}</Cell>
              <Cell>{blank ? '' : formatCount(row.leadsMeta)}</Cell>
              <Cell>{formatCount(row.leads)}</Cell>
              <Cell
                title={
                  !blank && d.cpl === null && row.leads > 0 && row.spendCents > 0
                    ? coverageNote('leads', row.leadCoverage)
                    : undefined
                }
              >
                {blank ? '' : money2(d.cpl)}
              </Cell>
              <Cell>{formatCount(row.bookings)}</Cell>
              <Cell
                title={
                  !blank && d.costPerBooking === null && row.bookings > 0 && row.spendCents > 0
                    ? coverageNote('bookings', row.bookingCoverage)
                    : undefined
                }
              >
                {blank ? '' : money2(d.costPerBooking)}
              </Cell>
              <Cell>{formatCount(row.shows)}</Cell>
              <Cell>{formatPercent(d.showPct, 0)}</Cell>
              <Cell>{row.revenueCents > 0 ? formatMoney(row.revenueCents) : '—'}</Cell>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="font-semibold">
          <Cell align="left" className="bg-surface-sunken">
            Total
          </Cell>
          <Cell align="left" className="bg-surface-sunken" />
          <Cell align="left" className="bg-surface-sunken text-[10px] font-normal text-fg-subtle">
            {formatPercent(totals.leadCoverage, 0)} of leads ·{' '}
            {formatPercent(totals.bookingCoverage, 0)} of bookings attributed
          </Cell>
          {grain === 'ad' ? <Cell align="left" className="bg-surface-sunken" /> : null}
          <Cell className="bg-surface-sunken">{formatMoney(totals.spendCents)}</Cell>
          <Cell className="bg-surface-sunken">{formatCount(totals.impressions)}</Cell>
          <Cell className="bg-surface-sunken">{formatCount(totals.clicks)}</Cell>
          <Cell className="bg-surface-sunken">{formatPercent(t.ctr, 2)}</Cell>
          <Cell className="bg-surface-sunken">{money2(t.cpm)}</Cell>
          <Cell className="bg-surface-sunken">{formatCount(totals.leadsMeta)}</Cell>
          <Cell className="bg-surface-sunken">{formatCount(totals.leads)}</Cell>
          <Cell className="bg-surface-sunken" title="Spend ÷ all leads, attributed or not">
            {money2(totals.leads === 0 ? null : totals.spendCents / 100 / totals.leads)}
          </Cell>
          <Cell className="bg-surface-sunken">{formatCount(totals.bookings)}</Cell>
          <Cell className="bg-surface-sunken" title="Spend ÷ all bookings, attributed or not">
            {money2(totals.bookings === 0 ? null : totals.spendCents / 100 / totals.bookings)}
          </Cell>
          <Cell className="bg-surface-sunken">{formatCount(totals.shows)}</Cell>
          <Cell className="bg-surface-sunken">{formatPercent(t.showPct, 0)}</Cell>
          <Cell className="bg-surface-sunken">
            {totals.revenueCents > 0 ? formatMoney(totals.revenueCents) : '—'}
          </Cell>
        </tr>
      </tfoot>
    </table>
  );
}
