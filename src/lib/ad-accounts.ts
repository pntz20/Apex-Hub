/**
 * Who owns which Meta ad account's spend.
 *
 * client_ad_accounts (0083) is the only thing windsor-ads reads. The Settings
 * screens used to write clients.ad_account_id instead, so mapping an account
 * in the UI changed nothing about where spend landed. Every screen that maps
 * an account now goes through here.
 *
 * clients.ad_account_id is kept filled (with one of the client's owned
 * accounts) only because older screens still display it. Nothing that moves
 * money reads it.
 */
import type { serviceClient } from '@/lib/supabase/service';

type Db = ReturnType<typeof serviceClient>;

export interface AdAccountResult {
  ok: boolean;
  message: string;
}

/** Windsor reports ids bare. Accept a pasted act_ prefix. */
export function bareAccountId(accountId: string): string {
  return accountId.trim().replace(/^act_/, '');
}

/** Owned (spend-counting) accounts, keyed by client id. */
export async function ownedAccountsByClient(
  db: Db,
): Promise<Map<string, { accountId: string; accountName: string | null }[]>> {
  const rows = await db
    .from('client_ad_accounts')
    .select('client_id, ad_account_id, account_name')
    .eq('owns_spend', true)
    .order('ad_account_id');
  if (rows.error) throw rows.error;

  const byClient = new Map<string, { accountId: string; accountName: string | null }[]>();
  for (const row of rows.data ?? []) {
    const list = byClient.get(row.client_id) ?? [];
    list.push({ accountId: bareAccountId(row.ad_account_id), accountName: row.account_name });
    byClient.set(row.client_id, list);
  }
  return byClient;
}

/** Keep the legacy column pointing at one of the client's owned accounts. */
async function refreshLegacyColumn(db: Db, clientId: string): Promise<void> {
  const owned = await db
    .from('client_ad_accounts')
    .select('ad_account_id')
    .eq('client_id', clientId)
    .eq('owns_spend', true)
    .order('created_at')
    .limit(1);
  if (owned.error) throw owned.error;

  const first = owned.data?.[0]?.ad_account_id ?? null;
  const updated = await db
    .from('clients')
    .update({ ad_account_id: first ? bareAccountId(first) : null })
    .eq('id', clientId);
  if (updated.error) throw updated.error;
}

/**
 * Make this client the owner of the account's spend.
 *
 * Refuses when another client already owns it: two owners would count the
 * spend twice and halve both practices' cost per booking. The partial unique
 * index in 0083 enforces the same thing; this just gives a readable message.
 */
export async function claimAdAccount(
  db: Db,
  input: { clientId: string; accountId: string; accountName?: string | null },
): Promise<AdAccountResult> {
  const accountId = bareAccountId(input.accountId);
  if (!/^\d+$/.test(accountId)) {
    return { ok: false, message: 'Ad account id should be digits only.' };
  }

  const owner = await db
    .from('client_ad_accounts')
    .select('client_id, client:clients!inner(name)')
    .eq('owns_spend', true)
    .in('ad_account_id', [accountId, `act_${accountId}`])
    .neq('client_id', input.clientId)
    .maybeSingle();
  if (owner.error) return { ok: false, message: owner.error.message };
  if (owner.data) {
    const client = owner.data.client as unknown as { name: string } | null;
    return {
      ok: false,
      message: `That account's spend already belongs to ${client?.name ?? 'another client'}. Remove it there first.`,
    };
  }

  const written = await db.from('client_ad_accounts').upsert(
    {
      client_id: input.clientId,
      ad_account_id: accountId,
      owns_spend: true,
      ...(input.accountName ? { account_name: input.accountName } : {}),
      note: 'Mapped in Settings.',
    },
    { onConflict: 'client_id,ad_account_id' },
  );
  if (written.error) return { ok: false, message: written.error.message };

  await refreshLegacyColumn(db, input.clientId);
  return { ok: true, message: 'Mapped. Spend moves on the next ads sync.' };
}

/** Stop this client owning the account's spend. */
export async function releaseAdAccount(
  db: Db,
  input: { clientId: string; accountId: string },
): Promise<AdAccountResult> {
  const accountId = bareAccountId(input.accountId);

  const removed = await db
    .from('client_ad_accounts')
    .delete()
    .eq('client_id', input.clientId)
    .in('ad_account_id', [accountId, `act_${accountId}`]);
  if (removed.error) return { ok: false, message: removed.error.message };

  await refreshLegacyColumn(db, input.clientId);
  return { ok: true, message: 'Removed.' };
}
