/**
 * PPS 0 Error: check the names loaded for billing before Monday's charge run.
 *
 * Pay-per-show practices are charged early Monday (~2:03am CT) for the patient
 * names sitting in their "Lead Name For Billing N" fields in the Pay Per Show
 * System account (L6Zptc92iQ0gGK0EI2Jz): one contact per practice, up to 10
 * slots per service type (standard, Hybrid, GD). Names land there when a
 * consult is marked Showed, or when HighLevel's "008. 3-Day Auto-Charge"
 * finds it unmarked after the wait.
 *
 * The second path is how a patient whose appointment was moved got charged:
 * nothing re-checks the appointment when the name is loaded. So this reads
 * every loaded name and compares it with that practice's appointments in the
 * Hub, and flags what should not be charged as it stands:
 *
 *   future     no past appointment that showed, but one still ahead
 *              (moved, or loaded early)
 *   no_show    the matching appointment is marked no-show
 *   cancelled  the matching appointment is cancelled
 *   not_found  no appointment for that name at that practice
 *
 * Names are compared the same way as the daily unbilled check (trigram
 * similarity, 0.5 or better). Read-only: it never edits a billing field.
 */
import { similarity, shortName } from '@/lib/billing/pps-unbilled';
import { ghlGet } from '@/lib/integrations/ghl';
import { serviceClient } from '@/lib/supabase/service';

/** #tech-team. Override with SLACK_PPS_ALERT_CHANNEL. */
export const PRECHARGE_ALERT_CHANNEL = 'C094DPKSP45';

/** The Pay Per Show System sub-account. Override with PPS_SYSTEM_LOCATION_ID. */
export const PPS_SYSTEM_LOCATION_ID = 'L6Zptc92iQ0gGK0EI2Jz';

const MATCH_AT = 0.5;
const LOOKBACK_DAYS = 60;
const LOOKAHEAD_DAYS = 180;

export type Verdict = 'ok' | 'future' | 'no_show' | 'cancelled' | 'not_found';

export interface Appt {
  clientId: string;
  patientName: string;
  scheduledAt: string; // ISO
  status: string;
}

export interface LoadedName {
  practice: string;
  slot: string;
  name: string;
}

export interface Finding extends LoadedName {
  verdict: Exclude<Verdict, 'ok'>;
  /** The date that explains the verdict (yyyy-mm-dd), when there is one. */
  on: string | null;
}

/** "GD - Lead Name For Billing 3" and its relatives; not any other field. */
export function isBillingField(name: string): boolean {
  return /lead name for billing\s*\d+\s*$/i.test(name.trim());
}

/** The non-blank billing slots on one contact, in slot order. */
export function loadedNames(
  customFields: Array<{ id?: unknown; value?: unknown; field_value?: unknown }>,
  fieldNames: Map<string, string>,
): Array<{ slot: string; name: string }> {
  const out: Array<{ slot: string; name: string }> = [];
  for (const field of customFields) {
    const id = typeof field.id === 'string' ? field.id : null;
    if (!id) continue;
    const label = fieldNames.get(id);
    if (!label) continue;
    const raw = field.value ?? field.field_value;
    const value = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : '';
    const name = value.trim();
    if (name !== '') out.push({ slot: label, name });
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}

/** What the Hub's appointments say about one loaded name. */
export function judge(
  name: string,
  appts: Appt[],
  now: Date,
): { verdict: Verdict; on: string | null } {
  const matches = appts.filter((a) => similarity(name, a.patientName) >= MATCH_AT);
  if (matches.length === 0) return { verdict: 'not_found', on: null };

  const nowMs = now.getTime();
  const past = matches
    .filter((a) => Date.parse(a.scheduledAt) <= nowMs)
    .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt));
  const future = matches
    .filter((a) => Date.parse(a.scheduledAt) > nowMs && a.status !== 'cancelled')
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));

  if (past.some((a) => a.status === 'showed')) return { verdict: 'ok', on: null };

  // Unmarked and still ahead is the case that charged a moved patient.
  const next = future[0];
  if (next) return { verdict: 'future', on: next.scheduledAt.slice(0, 10) };

  const latest = past[0];
  if (!latest) return { verdict: 'not_found', on: null };
  const latestOn = latest.scheduledAt.slice(0, 10);
  if (latest.status === 'no_show') return { verdict: 'no_show', on: latestOn };
  if (latest.status === 'cancelled') return { verdict: 'cancelled', on: latestOn };
  // Past and never marked: the 3-day auto-charge rule says charge it.
  return { verdict: 'ok', on: null };
}

function norm(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * The Hub practices a billing contact's business name belongs to.
 *
 * Billing contacts are named by hand and do not always match the Hub
 * ("Airway Orthodontics" for the TMJ Sleep Airway Orthodontics locations,
 * "Team Dental" for two practices), and a loose match once paired a contact
 * with the wrong practice. So, safest first:
 *
 *   1. exact name (group or location)            -> that practice
 *   2. the name as whole words inside practice    -> all of them; a patient at
 *      names                                         any of those locations counts
 *   3. trigram similarity >= 0.75, one clear best -> that practice
 *
 * Anything else is reported as not checked rather than guessed.
 */
export function matchPractice(
  businessName: string,
  practices: Array<{ key: string; names: string[] }>,
): string[] {
  const target = norm(businessName);
  if (target.trim() === '') return [];

  const exact = practices.filter((p) => p.names.some((n) => norm(n) === target));
  if (exact.length > 0) return exact.map((p) => p.key);

  const contained = practices.filter((p) => p.names.some((n) => norm(n).includes(target)));
  if (contained.length > 0) return contained.map((p) => p.key);

  const scored = practices
    .map((p) => ({ key: p.key, score: Math.max(0, ...p.names.map((n) => similarity(businessName, n))) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best && best.score >= 0.75 && (!second || second.score < best.score)) return [best.key];
  return [];
}

function shortDate(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

const REASON: Record<Finding['verdict'], (on: string | null) => string> = {
  future: (on) => `appointment is still ahead${on ? ` (${shortDate(on)})` : ''}, moved or loaded early`,
  no_show: (on) => `marked no-show${on ? ` (${shortDate(on)})` : ''}`,
  cancelled: (on) => `appointment cancelled${on ? ` (${shortDate(on)})` : ''}`,
  not_found: () => 'no appointment for this name in the Hub (check spelling, or remove)',
};

/** "GD - Lead Name For Billing 3" -> "GD slot 3"; "Lead Name For Billing 3" -> "slot 3". */
export function slotLabel(field: string): string {
  const match = field.match(/^(.*?)\s*-?\s*lead name for billing\s*(\d+)\s*$/i);
  if (!match) return field;
  const prefix = (match[1] ?? '').trim();
  return prefix ? `${prefix} slot ${match[2]}` : `slot ${match[2]}`;
}

export function prechargeSlackText(
  findings: Finding[],
  loadedCount: number,
  practiceCount: number,
  unmatchedPractices: string[],
): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (loadedCount === 0 && unmatchedPractices.length === 0) {
    return ':warning: *PPS pre-charge check:* no names were read from the billing fields. Either nothing is loaded for Monday, or the check could not read them; please look in the Pay Per Show System account before ~2am CT Monday.';
  }
  if (findings.length === 0 && unmatchedPractices.length === 0) {
    return `:white_check_mark: *PPS pre-charge check:* ${plural(loadedCount, 'name')} loaded across ${plural(practiceCount, 'practice')}; nothing to fix before Monday's charge run.`;
  }
  const lines = [
    `:rotating_light: *PPS pre-charge check: ${plural(findings.length, 'loaded name')} to look at before Monday's charge run*`,
    `${plural(loadedCount, 'name')} loaded across ${plural(practiceCount, 'practice')}. Fix these in the Pay Per Show System account before ~2am CT Monday.`,
    '',
  ];
  let practice = '';
  for (const f of findings) {
    if (f.practice !== practice) {
      practice = f.practice;
      lines.push(`*${practice}*`);
    }
    lines.push(`• ${shortName(f.name)} · ${slotLabel(f.slot)} · ${REASON[f.verdict](f.on)}`);
  }
  if (unmatchedPractices.length > 0) {
    lines.push('');
    lines.push(
      `:grey_question: Not checked (billing contact not matched to a Hub practice): ${unmatchedPractices.join(', ')}`,
    );
  }
  return lines.join('\n');
}

interface RawField {
  id?: unknown;
  name?: unknown;
}
interface RawContact {
  id?: unknown;
  companyName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  customFields?: Array<{ id?: unknown; value?: unknown; field_value?: unknown }>;
}

export interface PrechargeResult {
  findings: Finding[];
  loadedCount: number;
  practiceCount: number;
  unmatchedPractices: string[];
}

export async function runPrecharge(now: Date): Promise<PrechargeResult> {
  const db = serviceClient();
  const locationId = process.env.PPS_SYSTEM_LOCATION_ID || PPS_SYSTEM_LOCATION_ID;

  const system = await db
    .from('clients')
    .select('id')
    .eq('crm_location_id', locationId)
    .maybeSingle();
  if (system.error) throw system.error;
  if (!system.data) {
    throw new Error(`No Hub client for the Pay Per Show System location ${locationId}.`);
  }
  const systemClientId = system.data.id as string;

  const defs = await ghlGet<{ customFields?: RawField[] }>(
    systemClientId,
    `/locations/${locationId}/customFields`,
  );
  const fieldNames = new Map<string, string>();
  for (const f of defs.customFields ?? []) {
    if (typeof f.id === 'string' && typeof f.name === 'string' && isBillingField(f.name)) {
      fieldNames.set(f.id, f.name.trim());
    }
  }
  if (fieldNames.size === 0) {
    throw new Error('No "Lead Name For Billing" fields found in the Pay Per Show System account.');
  }

  const contacts: RawContact[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await ghlGet<{ contacts?: RawContact[] }>(systemClientId, '/contacts/', {
      locationId,
      limit: '100',
      page: String(page),
    });
    const rows = body.contacts ?? [];
    contacts.push(...rows);
    if (rows.length < 100) break;
  }

  // Practices: each live group, known by its own name and its locations' names.
  const [groups, clients] = await Promise.all([
    db.from('client_groups').select('id, name, status').in('status', ['active', 'onboarding']),
    db.from('clients').select('id, name, group_id'),
  ]);
  if (groups.error) throw groups.error;
  if (clients.error) throw clients.error;

  const clientsByGroup = new Map<string, Array<{ id: string; name: string }>>();
  for (const c of clients.data ?? []) {
    if (!c.group_id) continue;
    const list = clientsByGroup.get(c.group_id) ?? [];
    list.push({ id: c.id, name: c.name ?? '' });
    clientsByGroup.set(c.group_id, list);
  }
  const practices = (groups.data ?? []).map((g) => ({
    key: g.id as string,
    label: (g.name as string | null) ?? 'Unknown practice',
    names: [g.name as string | null, ...(clientsByGroup.get(g.id as string) ?? []).map((c) => c.name)]
      .filter((n): n is string => typeof n === 'string' && n.trim() !== ''),
  }));
  const practiceByKey = new Map(practices.map((p) => [p.key, p]));

  const loaded: Array<LoadedName & { groupIds: string[] }> = [];
  const unmatched: string[] = [];
  for (const contact of contacts) {
    const names = loadedNames(contact.customFields ?? [], fieldNames);
    if (names.length === 0) continue;
    const company = typeof contact.companyName === 'string' ? contact.companyName.trim() : '';
    const person = [contact.firstName, contact.lastName]
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .trim();
    const business = company || person;
    const groupIds = business ? matchPractice(business, practices) : [];
    if (groupIds.length === 0) {
      unmatched.push(business || 'unnamed contact');
      continue;
    }
    const only = groupIds.length === 1 ? groupIds[0] : undefined;
    const label = (only && practiceByKey.get(only)?.label) || business;
    for (const n of names) loaded.push({ practice: label, slot: n.slot, name: n.name, groupIds });
  }

  const allGroupIds = [...new Set(loaded.flatMap((l) => l.groupIds))];
  const clientIds = allGroupIds.flatMap((g) => (clientsByGroup.get(g) ?? []).map((c) => c.id));

  const apptsByGroup = new Map<string, Appt[]>();
  if (clientIds.length > 0) {
    const from = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString();
    const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000).toISOString();
    const appts = await db
      .from('appointments')
      .select('client_id, patient_name, scheduled_at, status')
      .in('client_id', clientIds)
      .gte('scheduled_at', from)
      .lte('scheduled_at', to)
      .limit(10000);
    if (appts.error) throw appts.error;

    const groupOfClient = new Map<string, string>();
    for (const [g, list] of clientsByGroup) for (const c of list) groupOfClient.set(c.id, g);
    for (const a of appts.data ?? []) {
      const g = groupOfClient.get(a.client_id as string);
      if (!g || !a.patient_name || !a.scheduled_at) continue;
      const list = apptsByGroup.get(g) ?? [];
      list.push({
        clientId: a.client_id as string,
        patientName: a.patient_name as string,
        scheduledAt: a.scheduled_at as string,
        status: String(a.status),
      });
      apptsByGroup.set(g, list);
    }
  }

  const findings: Finding[] = [];
  for (const l of loaded) {
    const pool = l.groupIds.flatMap((g) => apptsByGroup.get(g) ?? []);
    const { verdict, on } = judge(l.name, pool, now);
    if (verdict !== 'ok') {
      findings.push({ practice: l.practice, slot: l.slot, name: l.name, verdict, on });
    }
  }
  findings.sort(
    (a, b) =>
      a.practice.localeCompare(b.practice) ||
      a.slot.localeCompare(b.slot, undefined, { numeric: true }),
  );

  return {
    findings,
    loadedCount: loaded.length,
    practiceCount: new Set(loaded.map((l) => l.practice)).size,
    unmatchedPractices: unmatched,
  };
}
