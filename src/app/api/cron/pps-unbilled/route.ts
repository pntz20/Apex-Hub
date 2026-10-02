/**
 * PPS 0 Error: daily list of stat-sheet shows with no successful charge,
 * posted to #tech-team. Silent when the list is empty.
 *
 * `?dry=1` returns the list without posting.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { loadUnbilled, PPS_ALERT_CHANNEL, unbilledSlackText } from '@/lib/billing/pps-unbilled';
import { authorisedCron } from '@/lib/cron';
import { postMessage } from '@/lib/slack/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorisedCron(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const dry = request.nextUrl.searchParams.get('dry') === '1';

  let rows;
  try {
    rows = await loadUnbilled(today);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  let posted = false;
  if (!dry && rows.length > 0) {
    posted = await postMessage(
      process.env.SLACK_PPS_ALERT_CHANNEL || PPS_ALERT_CHANNEL,
      unbilledSlackText(rows),
      'bot',
    );
  }

  return NextResponse.json({
    ok: true,
    today,
    unbilled: rows.length,
    posted,
    rows: dry
      ? rows.map((r) => ({ practice: r.practice, on: r.appointmentOn, due: r.dueOn, reason: r.reason }))
      : undefined,
  });
}
