/**
 * A Slack post in #isr-wins for every new booking (CFT step 16).
 *
 * The SOP has "Appointment Booked -> Slack". Two Make scenarios have done it:
 * one posted the patient's email, phone and a paragraph of patient notes to
 * #isr-wins, and its replacement (6319925, "2. Fulfillment Tracker -
 * Appointment Data") has the same fields and no GoHighLevel workflow calling
 * it, so the channel has been quiet since 3 Sep. This keeps the win and drops
 * the record: practice, who booked it, first name and last initial, when, the
 * campaign, and whether the deposit was taken. No email, phone, insurance or
 * notes - the channel has members on personal accounts and Slack keeps
 * everything searchable.
 *
 * Runs after the hourly crm-appointments pass (cron/sync-appointments), so a
 * booking is announced within about an hour of being made.
 *
 * Only bookings made in the last ALERT_WINDOW_HOURS are posted. That is what
 * stops the first run from announcing every booking since January, and what
 * stops a day-late backfill from announcing yesterday as news.
 *
 * Each booking is posted once: slack_alerted_at is set only after Slack
 * accepts the message, so a failed post is retried on the next cycle while the
 * booking is still inside the window.
 */
import type { SyncFn } from '@/lib/sync/runner';
import { postMessage } from '@/lib/slack/api';
import { serviceClient } from '@/lib/supabase/service';

/** #isr-wins. Override with SLACK_BOOKING_ALERT_CHANNEL. */
const DEFAULT_CHANNEL = 'C0BE77TBYRK';

const ALERT_WINDOW_HOURS = 3;

/** A run posts at most this many; the rest wait for the next cycle. */
const MAX_PER_RUN = 25;

/**
 * Dial log rows this close to the booking are taken as the call that made it.
 *
 * Wide on purpose: raw_call_rows.called_at is the lead's local wall time
 * labelled UTC (see the CFT notes), so the same moment can sit up to a few
 * hours away from booked_at.
 */
const AGENT_WINDOW_MS = 6 * 60 * 60 * 1000;

export function firstNameLastInitial(name: string | null): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]! : '';
  const tidy = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  return last ? `${tidy(first)} ${last.charAt(0).toUpperCase()}.` : tidy(first);
}

export function formatWhen(iso: string | null, timeZone: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const zone = timeZone || 'America/New_York';
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

export interface AlertFields {
  practice: string;
  bookedBy: string | null;
  patient: string | null;
  when: string | null;
  campaign: string | null;
  deposit: boolean | null;
}

/** The message. Nothing in it identifies a patient beyond a first name. */
export function alertText(fields: AlertFields): string {
  const lines = [
    `:tada: *New appointment booked${fields.bookedBy ? ` by ${fields.bookedBy}` : ''}!*`,
    `*Practice:* ${fields.practice}`,
  ];
  if (fields.patient) lines.push(`*Patient:* ${fields.patient}`);
  if (fields.when) lines.push(`*Appointment:* ${fields.when}`);
  if (fields.campaign) lines.push(`*Campaign:* ${fields.campaign}`);
  if (fields.deposit !== null) lines.push(`*Deposit collected:* ${fields.deposit ? 'Yes' : 'No'}`);
  return lines.join('\n');
}

function phone10(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export const syncBookingAlerts: SyncFn = async (ctx) => {
  const db = serviceClient();
  const channel = process.env.SLACK_BOOKING_ALERT_CHANNEL || DEFAULT_CHANNEL;
  const since = new Date(Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const pending = await db
    .from('appointments')
    .select(
      'id, client_id, patient_name, patient_phone, scheduled_at, booked_at, campaign_external_id, deposit_collected, status',
    )
    .eq('source', 'crm')
    .is('slack_alerted_at', null)
    .gte('booked_at', since)
    .order('booked_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (pending.error) throw pending.error;
  const rows = pending.data ?? [];
  ctx.counts.read = rows.length;
  if (rows.length === 0) return;

  const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean))] as string[];

  const [clients, campaigns, calls] = await Promise.all([
    db.from('clients').select('id, name, timezone, is_internal').in('id', clientIds),
    db
      .from('campaigns')
      .select('client_id, external_id, name')
      .in('client_id', clientIds),
    db
      .from('raw_call_rows')
      .select('client_id, agent_name, disposition, called_at, to_number')
      .in('client_id', clientIds)
      .ilike('disposition', '%appointment booked%')
      .gte('called_at', new Date(Date.now() - ALERT_WINDOW_HOURS * 3_600_000 - AGENT_WINDOW_MS).toISOString()),
  ]);
  if (clients.error) throw clients.error;
  if (campaigns.error) throw campaigns.error;
  if (calls.error) throw calls.error;

  const clientById = new Map((clients.data ?? []).map((client) => [client.id, client]));
  const campaignName = new Map(
    (campaigns.data ?? []).map((campaign) => [`${campaign.client_id}|${campaign.external_id}`, campaign.name]),
  );

  for (const row of rows) {
    const client = row.client_id ? clientById.get(row.client_id) : undefined;
    if (!client || client.is_internal || row.status === 'cancelled') {
      ctx.counts.skipped += 1;
      // Mark it so it is not reconsidered every hour; it was never news.
      await db.from('appointments').update({ slack_alerted_at: new Date().toISOString() }).eq('id', row.id);
      continue;
    }

    const bookedAt = row.booked_at ? new Date(row.booked_at).getTime() : Date.now();
    const phone = phone10(row.patient_phone);
    const booking = (calls.data ?? [])
      .filter(
        (call) =>
          call.client_id === row.client_id &&
          phone !== null &&
          phone10(call.to_number) === phone &&
          call.called_at !== null &&
          Math.abs(new Date(call.called_at).getTime() - bookedAt) <= AGENT_WINDOW_MS,
      )
      .sort(
        (a, b) =>
          Math.abs(new Date(a.called_at!).getTime() - bookedAt) -
          Math.abs(new Date(b.called_at!).getTime() - bookedAt),
      )[0];

    const deposit =
      row.deposit_collected === true
        ? true
        : booking?.disposition
          ? !/^no deposit/i.test(booking.disposition)
          : null;

    const text = alertText({
      practice: client.name,
      bookedBy: booking?.agent_name ?? null,
      patient: firstNameLastInitial(row.patient_name),
      when: formatWhen(row.scheduled_at, client.timezone),
      campaign: row.campaign_external_id
        ? (campaignName.get(`${row.client_id}|${row.campaign_external_id}`) ?? null)
        : null,
      deposit,
    });

    const posted = await postMessage(channel, text, 'bot');
    if (!posted) {
      ctx.recordError('Slack did not accept the booking alert', { appointmentId: row.id });
      continue;
    }

    const marked = await db
      .from('appointments')
      .update({ slack_alerted_at: new Date().toISOString() })
      .eq('id', row.id);
    if (marked.error) {
      ctx.recordError('posted but could not mark the booking as announced', {
        appointmentId: row.id,
        detail: marked.error.message,
      });
      continue;
    }
    ctx.counts.created += 1;
  }
};
