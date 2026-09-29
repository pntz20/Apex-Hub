'use server';

/**
 * The tracker's three hand-kept mappings (CFT step 20).
 *
 * Until 29 Sep 2026 every one of these was SQL-only, so onboarding a practice
 * or fixing a mismatched name needed a database session:
 *
 *  - tracker_practice_aliases: a practice name as the fulfilment sheet spells
 *    it, pointed at the Hub client it means.
 *  - campaign_practice_map: a Meta campaign id pointed at the practice it
 *    belongs to, for campaigns whose account is shared or mislabelled.
 *  - clients.is_internal: test and demo sub-accounts, kept out of the tracker
 *    and the ads warnings.
 *
 * Churn is not here on purpose: it already lives on the client's own page
 * (status = churned on client_groups), which is what windsor-ads reads.
 *
 * Plain form actions, so the page stays a server component. Each redirects
 * back with a short message in ?msg rather than throwing, because a failed
 * write here should read as an instruction, not an error page.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireAdmin } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

const PAGE = '/settings/tracker-mappings';

function done(message: string): never {
  revalidatePath(PAGE);
  revalidatePath('/dashboard');
  redirect(`${PAGE}?msg=${encodeURIComponent(message)}`);
}

const text = (form: FormData, key: string): string => String(form.get(key) ?? '').trim();

export async function addAlias(form: FormData): Promise<void> {
  await requireAdmin();
  const trackerName = text(form, 'tracker_name');
  const clientId = text(form, 'client_id');
  const note = text(form, 'note') || null;
  if (trackerName === '' || clientId === '') done('Give the sheet name and pick a practice.');

  const { error } = await serviceClient()
    .from('tracker_practice_aliases')
    .upsert({ tracker_name: trackerName, client_id: clientId, note }, { onConflict: 'tracker_name' });
  done(error ? `Could not save the alias: ${error.message}` : `Saved: "${trackerName}".`);
}

export async function removeAlias(form: FormData): Promise<void> {
  await requireAdmin();
  const trackerName = text(form, 'tracker_name');
  const { error } = await serviceClient()
    .from('tracker_practice_aliases')
    .delete()
    .eq('tracker_name', trackerName);
  done(error ? `Could not remove the alias: ${error.message}` : `Removed: "${trackerName}".`);
}

export async function addCampaignMap(form: FormData): Promise<void> {
  await requireAdmin();
  const campaignId = text(form, 'campaign_external_id').replace(/\D/g, '');
  const clientId = text(form, 'client_id');
  const note = text(form, 'note') || null;
  if (campaignId === '' || clientId === '') done('Give a numeric campaign id and pick a practice.');

  const db = serviceClient();
  const client = await db.from('clients').select('name').eq('id', clientId).maybeSingle();
  if (client.error || !client.data) done('That practice was not found.');

  // Unique on (practice_name, campaign_external_id): one campaign can be
  // listed against more than one practice on purpose (the sheet's ids were
  // mixed up between practices), so this adds or updates that one pair.
  const { error } = await db.from('campaign_practice_map').upsert(
    {
      campaign_external_id: campaignId,
      client_id: clientId,
      practice_name: client.data!.name,
      note,
    },
    { onConflict: 'practice_name,campaign_external_id' },
  );
  done(error ? `Could not save the campaign: ${error.message}` : `Saved campaign ${campaignId}.`);
}

export async function removeCampaignMap(form: FormData): Promise<void> {
  await requireAdmin();
  const id = text(form, 'id');
  const { error } = await serviceClient().from('campaign_practice_map').delete().eq('id', id);
  done(error ? `Could not remove the campaign: ${error.message}` : 'Campaign mapping removed.');
}

export async function setInternal(form: FormData): Promise<void> {
  await requireAdmin();
  const clientId = text(form, 'client_id');
  const internal = text(form, 'internal') === 'true';
  const { error } = await serviceClient()
    .from('clients')
    .update({ is_internal: internal })
    .eq('id', clientId);
  done(
    error
      ? `Could not update the practice: ${error.message}`
      : internal
        ? 'Marked internal: it no longer counts in the tracker.'
        : 'Marked as a real practice again.',
  );
}
