/**
 * PPS 0 Error: consults that showed on a practice's stat sheet but were never
 * charged in Stripe.
 *
 * Pay-per-show practices are charged weekly, on Monday, for the previous week's
 * shows; the charge description lists the patients ("Consults charged:"), which
 * billing_charges.consult_names already parses. So a show is billed when a
 * succeeded charge for the same practice names that patient, any time from a
 * month before the appointment (early loads happen). Nothing is reported until
 * the day after the Monday run that should have covered it.
 *
 * Names are typed by hand on both sides, so they are compared the way pg_trgm
 * does (trigram similarity, 0.5 or better), which absorbs the usual spelling
 * slips. Checked against 1-27 Sep 2026: it finds the misses found by hand
 * (Kind 15 Sep, Lompoc 15 and 21 Sep, Magic 24 Sep) and none of the spelling
 * differences.
 *
 * Why not the appointment ledger's unbilled_backlog: the ledger only knows a
 * show when the CRM or tracker recorded it, and the stat-sheet shows above never
 * reached it. The stat sheet is what the practice marks, so it is the source.
 *
 * A practice counts as pay-per-show when it has had a consult charge in the
 * last 120 days. Practices billed by manual invoice (Smile Ortho, VDNE) or never
 * charged per show are therefore not checked here.
 */
import { serviceClient } from '@/lib/supabase/service';

/** #tech-team. Override with SLACK_PPS_ALERT_CHANNEL. */
export const PPS_ALERT_CHANNEL = 'C094DPKSP45';

const MATCH_AT = 0.5;
const LOOKBACK_DAYS = 28;
/** Days after the due Monday before a missing charge is reported. */
const GRACE_DAYS = 1;

export interface ShowRow {
  clientId: string;
  practice: string;
  patientName: string | null;
  appointmentOn: string; // yyyy-mm-dd
}

export interface ChargeName {
  clientId: string;
  name: string;
  occurredOn: string; // yyyy-mm-dd
  outcome: string;
}

export interface UnbilledShow extends ShowRow {
  /** 'missing' = no charge names them; 'failed' = only a failed or pending charge does. */
  reason: 'missing' | 'failed';
  dueOn: string;
}

function trigrams(value: string): Set<string> {
  const out = new Set<string>();
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  for (const word of words) {
    if (word === '') continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm's similarity(): shared trigrams over all trigrams. */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday charge run that should cover a show: the first Monday after it. */
export function dueMonday(appointmentOn: string): string {
  const dow = new Date(`${appointmentOn}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
  return addDays(appointmentOn, dow === 0 ? 1 : 8 - dow);
}

export function findUnbilled(shows: ShowRow[], charges: ChargeName[], today: string): UnbilledShow[] {
  const out: UnbilledShow[] = [];
  for (const show of shows) {
    const dueOn = dueMonday(show.appointmentOn);
    if (addDays(dueOn, GRACE_DAYS) > today) continue;

    // Any charge from a month before (early loads) up to today: a show charged a
    // week late is late, not missing.
    const from = addDays(show.appointmentOn, -30);
    const name = show.patientName;
    const hits = name
      ? charges.filter(
          (c) =>
            c.clientId === show.clientId &&
            c.occurredOn >= from &&
            similarity(name, c.name) >= MATCH_AT,
        )
      : [];

    if (hits.some((c) => c.outcome === 'succeeded')) continue;
    out.push({ ...show, dueOn, reason: hits.length > 0 ? 'failed' : 'missing' });
  }
  return out.sort(
    (a, b) => a.practice.localeCompare(b.practice) || a.appointmentOn.localeCompare(b.appointmentOn),
  );
}

/** First name and last initial: enough to find the row, nothing more in Slack. */
export function shortName(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const head = parts[0];
  if (head === undefined) return '(no name on the sheet)';
  const first = head.charAt(0).toUpperCase() + head.slice(1).toLowerCase();
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

function shortDate(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function unbilledSlackText(rows: UnbilledShow[]): string {
  const lines = [
    `:moneybag: *PPS check: ${rows.length} show${rows.length === 1 ? '' : 's'} not charged*`,
    'Marked as showed on the stat sheet, but no successful Stripe charge names the patient.',
    '',
  ];
  let practice = '';
  for (const row of rows) {
    if (row.practice !== practice) {
      practice = row.practice;
      lines.push(`*${practice}*`);
    }
    const why = row.reason === 'failed' ? ' (charge failed or pending)' : '';
    lines.push(
      `• ${shortDate(row.appointmentOn)} ${shortName(row.patientName)}${why} · should have been in the ${shortDate(row.dueOn)} charge run`,
    );
  }
  lines.push('');
  lines.push('Please charge them, or reply in the thread if the name is spelled differently in Stripe.');
  return lines.join('\n');
}

export async function loadUnbilled(today: string): Promise<UnbilledShow[]> {
  const db = serviceClient();
  const since = addDays(today, -LOOKBACK_DAYS);
  const chargesSince = addDays(today, -(LOOKBACK_DAYS + 60));
  const ppsSince = addDays(today, -120);

  const pps = await db
    .from('billing_charges')
    .select('client_id')
    .gt('consult_count', 0)
    .gte('occurred_at', ppsSince);
  if (pps.error) throw pps.error;
  const ppsIds = [
    ...new Set((pps.data ?? []).map((r) => r.client_id).filter((id): id is string => !!id)),
  ];
  if (ppsIds.length === 0) return [];

  const [shows, charges, clients] = await Promise.all([
    db
      .from('stat_sheet_appointments')
      .select('client_id, patient_name, appointment_on, first_consultation_show')
      .in('client_id', ppsIds)
      .gte('appointment_on', since)
      .lte('appointment_on', today)
      .limit(5000),
    db
      .from('billing_charges')
      .select('client_id, consult_names, occurred_at, outcome')
      .in('client_id', ppsIds)
      .gte('occurred_at', chargesSince)
      .limit(5000),
    db.from('clients').select('id, name').in('id', ppsIds),
  ]);
  if (shows.error) throw shows.error;
  if (charges.error) throw charges.error;
  if (clients.error) throw clients.error;

  const names = new Map((clients.data ?? []).map((c) => [c.id, c.name ?? 'Unknown practice']));

  const showRows: ShowRow[] = (shows.data ?? [])
    .filter(
      (s) =>
        (s.first_consultation_show ?? '').trim().toUpperCase() === 'Y' &&
        !!s.appointment_on &&
        !!s.client_id,
    )
    .map((s) => ({
      clientId: s.client_id as string,
      practice: names.get(s.client_id as string) ?? 'Unknown practice',
      patientName: s.patient_name?.trim() || null,
      appointmentOn: s.appointment_on as string,
    }));

  const chargeNames: ChargeName[] = (charges.data ?? []).flatMap((c) =>
    (c.consult_names ?? []).map((name: string) => ({
      clientId: c.client_id as string,
      name,
      occurredOn: String(c.occurred_at).slice(0, 10),
      outcome: String(c.outcome),
    })),
  );

  return findUnbilled(showRows, chargeNames, today);
}
