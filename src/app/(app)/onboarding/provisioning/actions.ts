'use server';

/**
 * Retrying a sub-account build.
 *
 * The reason this exists rather than being a nice-to-have: the connected
 * GoHighLevel app may not hold locations.write yet, so the first attempt for any
 * practice can fail on authorisation. Without a retry, fixing the scope would
 * mean asking the practice to fill the form again.
 */
import { revalidatePath } from 'next/cache';

import { adaptGhlOnboarding, GHL_ONBOARDING_FORM_KEY } from '@/lib/onboarding/ghl-form';
import { provisionFromSubmission } from '@/lib/onboarding/provision';
import { requireAdmin } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

export interface RetryResult {
  ok: boolean;
  message: string;
}

/**
 * Provisions an onboarding submission that has never been attempted.
 *
 * Needed because of a real gap the first live test found: the submission saved,
 * provisioning silently did not run, and with no attempt row there was nothing
 * for Retry to act on — the answers were stranded in a table with no button
 * anywhere that could use them.
 */
export async function provisionSubmission(input: {
  submissionId: string;
  /** The sub-account the tech built by hand in HighLevel (CFT step 22). */
  locationId?: string;
}): Promise<RetryResult> {
  const caller = await requireAdmin();
  const db = serviceClient();

  const submission = await db
    .from('form_submissions')
    .select('id, payload, clinic_name, client_group_id, form_key')
    .eq('id', input.submissionId)
    .maybeSingle();

  if (submission.error) return { ok: false, message: submission.error.message };
  if (!submission.data) return { ok: false, message: 'No such submission.' };

  const locationId = cleanLocationId(input.locationId);
  if (locationId === false) return { ok: false, message: LOCATION_ID_HELP };

  const outcome = await provisionFromSubmission({
    submissionId: submission.data.id,
    clientGroupId: submission.data.client_group_id,
    clinicName: submission.data.clinic_name ?? '',
    answers: answersOf(submission.data.form_key, submission.data.payload),
    startedBy: caller.id,
    existingLocationId: locationId,
  });

  revalidatePath('/onboarding/provisioning');
  return { ok: outcome.ok, message: outcome.message };
}

export async function retryProvisioning(input: {
  runId: string;
  /** For an attempt with no sub-account yet: the one built by hand. */
  locationId?: string;
}): Promise<RetryResult> {
  const caller = await requireAdmin();
  const db = serviceClient();

  const run = await db
    .from('provisioning_runs')
    .select('id, submission_id, client_group_id, clinic_name, crm_location_id')
    .eq('id', input.runId)
    .maybeSingle();

  if (run.error) return { ok: false, message: run.error.message };
  if (!run.data) return { ok: false, message: 'No such attempt.' };

  /*
   * The answers come from the submission, not from the failed run.
   *
   * A run records what happened, not what was asked for. Re-reading the
   * submission means a retry after somebody corrects an answer picks up the
   * correction, and a retry with no submission attached fails honestly rather
   * than building a sub-account out of nothing.
   */
  if (!run.data.submission_id) {
    return {
      ok: false,
      message:
        'This attempt has no submission attached, so there are no answers to ' +
        'build from. Provision from the form instead.',
    };
  }

  const submission = await db
    .from('form_submissions')
    .select('id, payload, clinic_name, client_group_id, form_key')
    .eq('id', run.data.submission_id)
    .maybeSingle();

  if (submission.error) return { ok: false, message: submission.error.message };
  if (!submission.data) {
    return { ok: false, message: 'The submission behind this attempt is gone.' };
  }

  const pasted = cleanLocationId(input.locationId);
  if (pasted === false) return { ok: false, message: LOCATION_ID_HELP };

  const outcome = await provisionFromSubmission({
    submissionId: submission.data.id,
    clientGroupId: submission.data.client_group_id ?? run.data.client_group_id,
    clinicName: submission.data.clinic_name ?? run.data.clinic_name,
    answers: answersOf(submission.data.form_key, submission.data.payload),
    startedBy: caller.id,
    // The crux of a safe retry: if the account already exists, configure it
    // rather than creating a second one for the same practice.
    existingLocationId: run.data.crm_location_id ?? pasted,
  });

  revalidatePath('/onboarding/provisioning');

  return { ok: outcome.ok, message: outcome.message };
}

const LOCATION_ID_HELP =
  'That does not look like a HighLevel location id. Open the sub-account in ' +
  'HighLevel and copy the part after /location/ in the address bar.';

/**
 * A pasted location id, tidied: a whole HighLevel URL is accepted and the id
 * taken out of it. undefined = nothing pasted; false = pasted but not an id.
 */
function cleanLocationId(raw: string | undefined): string | null | false {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return null;
  const fromUrl = trimmed.match(/\/location\/([A-Za-z0-9]{10,40})/);
  const id = fromUrl ? fromUrl[1]! : trimmed;
  return /^[A-Za-z0-9]{10,40}$/.test(id) ? id : false;
}

/** GoHighLevel's form speaks question text; the Hub's speaks field names. */
function answersOf(formKey: string | null, payload: unknown): Record<string, string | undefined> {
  return formKey === GHL_ONBOARDING_FORM_KEY
    ? adaptGhlOnboarding((payload ?? {}) as Record<string, unknown>)
    : ((payload ?? {}) as Record<string, string | undefined>);
}
