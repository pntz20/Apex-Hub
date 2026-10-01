/**
 * The kick off form (CFT step 22): question -> sub-account custom value.
 *
 * Filled in by the account manager on the front desk call, 2-7 days after the
 * onboarding form, in Apex's onboarding sub-account (form 1SggeGDzW2d72OQ6zYVA,
 * "Onboarding Questionnaire (Account Manager Use)"). Its answers are what the
 * new practice's sub-account automations read, so they are written onto that
 * sub-account's custom values.
 *
 * Questions are matched on their text with punctuation and case folded,
 * because GoHighLevel sends the question label as the key. Custom value names
 * are the ones read off a snapshot-built account (Dr. Christopher Jones and
 * Associates, 1 Oct 2026), not guesses.
 *
 * Questions with no custom value of their own are not written anywhere; they
 * stay on the stored submission: Clinic Name, Clinic Website, Doctor Preferred
 * Name, Patient Delivery Type, Custom Scripting, Comprehensive / Limited Case
 * Price, Our Internal Appt Reminders, Marketing Platforms Requested and Daily
 * Ad Budget.
 */

export const KICKOFF_FORM_KEY = 'kick-off';

/** Question text -> custom value name. */
const MAP: ReadonlyArray<[question: string, customValue: string]> = [
  ['Doctor Type', 'Doctor Type'],
  ['Offer Type', 'Offer type'],
  ['Scheduling Type', 'Scheduling Type'],
  ['Scheduling Tutorial Link', 'Scheduling Tutorial Link'],
  ['Promotion Offer/Offers', 'Offer Name'],
  ['Sub Offers', 'Sub offers'],
  ['Custom Phrasing for Doctor/Clinic?', 'custom phrase'],
  ['Custom Pricing?', 'custom pricing'],
  [
    'Insurance Specifics: Direct Billing or Fee for Service?',
    'Insurance Specifics: Direct Billing or Fee for Service?',
  ],
  [
    'Insurance Specifics: Remainder amount after insurance application, financeable?',
    'Insurance Specifics: Remainder Financeable after Insurance Applied? (Yes/No)',
  ],
  ['Insurance Specifics: In Network Insurances?', 'Insurance Specifics: In network Insurances'],
  [
    'Insurance Specifics: Insurance Classes Accepted?',
    'Insurance Specifics: Insurance Accepted',
  ],
  ['In house financing payment terms', 'Inhouse Finance'],
  ['3rd party financing terms', '3rdparty-Finance'],
  ['Scheduler', 'Scheduler'],
  ['Office Text Phone Number', 'Front Desk Notification Phone Number'],
  ['Office Notification Emails', 'Front Desk Email'],
  [
    'New Patient Form automatically sent? If not, do we have the link to their NPF?',
    'New Patient Form automatically sent? If not, do we have the link to their NPF?',
  ],
  ['Address of Clinic/Clinics', 'Location Address'],
];

/**
 * Lower-case, letters and digits only, and anything in parentheses dropped -
 * the form appends "(not needed if completed in Doctor Onboarding Form)" to
 * some labels and may change that note without changing the question.
 */
export function fold(question: string): string {
  return question
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const FOLDED = MAP.map(([question, value]) => [fold(question), value] as const);

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const joined = value.map((item) => asText(item)).filter(Boolean).join(', ');
    return joined === '' ? null : joined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The custom values a kick off submission fills.
 *
 * A question matches when its folded text is a mapped question's folded text or
 * starts with it, so "In house financing payment terms. Minimum downpayment
 * amount, Monthly Payment Amounts" lands on Inhouse Finance. Blank answers are
 * dropped: an empty answer means "not discussed", not "clear the field".
 */
export function kickoffValues(answers: Record<string, unknown>): {
  values: Record<string, string>;
  unmapped: string[];
} {
  const values: Record<string, string> = {};
  const unmapped: string[] = [];

  for (const [question, raw] of Object.entries(answers)) {
    const answer = asText(raw);
    if (answer === null) continue;
    const folded = fold(question);

    if (folded.startsWith('number of clinics')) {
      const count = Number.parseInt(answer, 10);
      if (Number.isFinite(count)) values['Multi / Single Location'] = count > 1 ? 'Multi' : 'Single';
      continue;
    }

    const hit = FOLDED.find(([key]) => folded === key || folded.startsWith(`${key} `));
    if (hit) values[hit[1]] = answer;
    else unmapped.push(question);
  }

  return { values, unmapped };
}

/** #tech-team, where the Sales to CSM handoff posts. Override with SLACK_KICKOFF_ALERT_CHANNEL. */
export const KICKOFF_ALERT_CHANNEL = 'C094DPKSP45';

export interface KickoffAlert {
  clinic: string | null;
  /** 'written' = values went onto the sub-account; the others say why not. */
  outcome: 'written' | 'unmatched' | 'failed';
  locationId: string | null;
  written: string[];
  missing: string[];
  failed: Array<{ name: string; reason: string }>;
  unmapped: string[];
  error?: string;
  /** Where the practice can be set up by hand, for the unmatched case. */
  provisioningUrl: string | null;
}

/**
 * The #tech-team message for a kick off form, laid out like the Sales to CSM
 * handoff post so the two read as one onboarding thread of events. Unlike that
 * post, a line with nothing to say is left out rather than shown empty.
 *
 * Field names only, never answers: pricing and insurance terms stay in the
 * sub-account and on the stored submission.
 */
export function kickoffSlackText(alert: KickoffAlert): string {
  const clinic = alert.clinic?.trim() || 'Unnamed clinic';
  const lines: string[] = [];

  if (alert.outcome === 'written') {
    lines.push(':tada: *Kick Off Form Submitted!*');
    lines.push('The kick off form is in and its answers are on the sub-account custom values.');
  } else if (alert.outcome === 'unmatched') {
    lines.push(':warning: *Kick Off Form Submitted - no sub-account matched*');
    lines.push('The form is saved in the Hub, but no set-up sub-account was found for it, so nothing was written.');
  } else {
    lines.push(':warning: *Kick Off Form Submitted - custom values not written*');
    lines.push('The form is saved in the Hub, but writing to the sub-account failed.');
  }

  lines.push('');
  lines.push(`:hospital: Clinic: ${clinic}`);
  if (alert.locationId) {
    lines.push(`:link: Sub-account: <https://app.gohighlevel.com/v2/location/${alert.locationId}/dashboard|${alert.locationId}>`);
  }

  if (alert.outcome === 'written') {
    const tried = alert.written.length + alert.missing.length + alert.failed.length;
    lines.push(`:white_check_mark: Custom values written: ${alert.written.length} of ${tried}`);
    if (alert.missing.length > 0) {
      lines.push(`:grey_question: Not in the sub-account: ${alert.missing.join(', ')}`);
    }
    if (alert.failed.length > 0) {
      lines.push(`:x: Refused: ${alert.failed.map((item) => item.name).join(', ')}`);
    }
  }
  if (alert.outcome === 'failed' && alert.error) {
    lines.push(`:x: Error: ${alert.error.slice(0, 200)}`);
  }
  if (alert.unmapped.length > 0) {
    lines.push(`:memo: Questions with no custom value: ${alert.unmapped.length}`);
  }

  lines.push('');
  if (alert.outcome === 'written') {
    lines.push(
      alert.missing.length + alert.failed.length > 0
        ? 'Please fill in the values listed above by hand.'
        : 'Please review and proceed with launch prep.',
    );
  } else if (alert.outcome === 'unmatched') {
    lines.push(
      alert.provisioningUrl
        ? `Please set up the practice in <${alert.provisioningUrl}|Onboarding → Provisioning>, then write the values.`
        : 'Please set up the practice in Onboarding → Provisioning, then write the values.',
    );
  } else {
    lines.push('Please retry from the Hub or write the values by hand.');
  }

  return lines.join('\n');
}

/** The clinic the account manager named, for matching the practice. */
export function kickoffClinicName(answers: Record<string, unknown>): string | null {
  for (const [question, raw] of Object.entries(answers)) {
    if (fold(question) === 'clinic name') return asText(raw);
  }
  return null;
}
