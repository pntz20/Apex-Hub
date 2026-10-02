/**
 * PPS 0 Error: before Monday's charge run, check every name loaded for billing
 * in the Pay Per Show System account against the Hub's appointments, and post
 * the ones that should not be charged as they stand to #tech-team.
 *
 * Runs Friday and Sunday 22:00 UTC (5pm CT), so there is a working day and a
 * last look before the ~2am CT Monday run. Posts an all-clear line when there
 * is nothing to fix, so a silent channel means it did not run.
 *
 * `?dry=1` returns the result without posting.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  PRECHARGE_ALERT_CHANNEL,
  prechargeSlackText,
  runPrecharge,
} from '@/lib/billing/pps-precharge';
import { authorisedCron } from '@/lib/cron';
import { postMessage } from '@/lib/slack/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorisedCron(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  const dry = request.nextUrl.searchParams.get('dry') === '1';
  const channel = process.env.SLACK_PPS_ALERT_CHANNEL || PRECHARGE_ALERT_CHANNEL;

  let result;
  try {
    result = await runPrecharge(new Date());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!dry) {
      await postMessage(
        channel,
        `:warning: *PPS pre-charge check failed:* ${message.slice(0, 300)}`,
        'bot',
      ).catch(() => false);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const text = prechargeSlackText(
    result.findings,
    result.loadedCount,
    result.practiceCount,
    result.unmatchedPractices,
  );

  const posted = dry ? false : await postMessage(channel, text, 'bot');

  return NextResponse.json({
    ok: true,
    loaded: result.loadedCount,
    practices: result.practiceCount,
    flagged: result.findings.length,
    unmatched: result.unmatchedPractices,
    posted,
    findings: dry
      ? result.findings.map((f) => ({
          practice: f.practice,
          slot: f.slot,
          verdict: f.verdict,
          on: f.on,
        }))
      : undefined,
  });
}
