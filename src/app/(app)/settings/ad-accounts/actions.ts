'use server';

/**
 * Mapping a Windsor ad account onto a practice.
 *
 * This is the single most consequential thing on the Settings screens, because
 * every cost figure in the app hangs off it: get one wrong and one practice's
 * spend is reported against another's bookings, in a report that goes to the
 * client. So an account can only have one owner.
 *
 * Writes go to client_ad_accounts, which is what windsor-ads reads. Until
 * 24 Sep 2026 this wrote clients.ad_account_id, which the sync ignores.
 */
import { revalidatePath } from 'next/cache';

import {
  claimAdAccount,
  releaseAdAccount,
  type AdAccountResult,
} from '@/lib/ad-accounts';
import { requireAdmin } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

export type MapResult = AdAccountResult;

function revalidate() {
  revalidatePath('/settings/ad-accounts');
  revalidatePath('/settings');
  revalidatePath('/ads');
  revalidatePath('/dashboard');
}

export async function addClientAdAccount(input: {
  clientId: string;
  accountId: string;
  accountName?: string | null;
}): Promise<MapResult> {
  await requireAdmin();
  if (input.accountId.trim() === '') return { ok: false, message: 'Pick an account.' };

  const result = await claimAdAccount(serviceClient(), input);
  if (result.ok) revalidate();
  return result;
}

export async function removeClientAdAccount(input: {
  clientId: string;
  accountId: string;
}): Promise<MapResult> {
  await requireAdmin();

  const result = await releaseAdAccount(serviceClient(), input);
  if (result.ok) revalidate();
  return result;
}
