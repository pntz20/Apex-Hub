/**
 * Reconcile ticket threads with Slack.
 *
 * The events route copies replies and screenshots into tickets as they happen.
 * This is the safety net behind it: Slack drops events when the endpoint is
 * slow or down, and tickets filed before the sync existed have never been
 * read. Every 10 minutes it re-reads the thread of each live ticket (open, in
 * progress, or raised in the last 30 days) and copies in whatever is missing.
 *
 * Safe to run as often as you like: comments and files are keyed on Slack's
 * own ids (migration 0104), so a second pass writes nothing. It sends no
 * notifications; the live path does that.
 *
 * The first run after deploy is the backfill.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { authorisedCron } from '@/lib/cron';
import { serviceClient } from '@/lib/supabase/service';
import { syncTicketFromSlack, type People } from '@/lib/tickets/slack-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * conversations.replies is Slack tier 3 (about 50 a minute). 40 threads a run,
 * each normally one page, stays under it with room for the live route.
 */
const PER_RUN = 40;

export async function GET(request: NextRequest) {
  if (!authorisedCron(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const tickets = await serviceClient()
    .from('tech_tickets')
    .select('id')
    .not('slack_channel_id', 'is', null)
    .or(`status.in.(open,in_progress),created_at.gte.${since}`)
    .order('created_at', { ascending: false })
    .limit(PER_RUN);

  if (tickets.error) {
    return NextResponse.json({ error: tickets.error.message }, { status: 500 });
  }

  const people: People = new Map();
  let newComments = 0;
  let newFiles = 0;
  let skippedFiles = 0;
  const unreadable: string[] = [];

  for (const ticket of tickets.data ?? []) {
    const result = await syncTicketFromSlack(ticket.id, people);
    if (!result.ok) {
      unreadable.push(ticket.id);
      continue;
    }
    newComments += result.newComments;
    newFiles += result.newFiles;
    skippedFiles += result.skippedFiles;
  }

  return NextResponse.json({
    ok: unreadable.length === 0,
    checked: tickets.data?.length ?? 0,
    newComments,
    newFiles,
    skippedFiles,
    unreadable,
  });
}
