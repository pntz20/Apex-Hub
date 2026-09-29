import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/PageHeader';
import { isPrivileged } from '@/config/roles';
import { currentCaller } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

import {
  addAlias,
  addCampaignMap,
  removeAlias,
  removeCampaignMap,
  setInternal,
} from './actions';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Tracker mappings' };

/**
 * The fulfilment tracker's hand-kept mappings, on a screen (CFT step 20).
 *
 * Sheet-name aliases, campaign-to-practice overrides and the internal/test
 * flag used to be SQL-only. Churn stays on each client's own page, which
 * already writes the status windsor-ads reads.
 */
export default async function TrackerMappingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await currentCaller();
  if (!caller) redirect('/login');
  if (!isPrivileged(caller.role)) redirect('/dashboard');

  const params = await searchParams;
  const message = typeof params['msg'] === 'string' ? params['msg'] : null;

  const db = serviceClient();
  const [clients, aliases, campaigns] = await Promise.all([
    db.from('clients').select('id, name, is_internal, is_active').order('name'),
    db.from('tracker_practice_aliases').select('tracker_name, client_id, note').order('tracker_name'),
    db
      .from('campaign_practice_map')
      .select('id, campaign_external_id, practice_name, client_id, note')
      .order('practice_name'),
  ]);
  if (clients.error) throw clients.error;
  if (aliases.error) throw aliases.error;
  if (campaigns.error) throw campaigns.error;

  const allClients = clients.data ?? [];
  const nameById = new Map(allClients.map((client) => [client.id, client.name]));
  const pickable = allClients.filter((client) => client.is_active);

  const input =
    'rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle';
  const button =
    'rounded-md border border-line bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-hover';
  const danger = 'text-xs text-negative hover:underline';

  const clientSelect = (
    <select name="client_id" required className={input} defaultValue="">
      <option value="" disabled>
        Practice…
      </option>
      {pickable.map((client) => (
        <option key={client.id} value={client.id}>
          {client.name}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <PageHeader
        title="Tracker mappings"
        description="Sheet names, campaign owners and test accounts for the fulfilment tracker"
        actions={
          <Link href="/settings" className="text-xs text-fg-muted hover:text-fg">
            Back to settings
          </Link>
        }
      />

      {message ? (
        <p className="mb-5 rounded-md bg-surface-sunken px-3 py-2 text-sm text-fg">{message}</p>
      ) : null}

      <section className="mb-8 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Sheet-name aliases</h2>
        <p className="mt-1 max-w-3xl text-xs text-fg-subtle">
          How the fulfilment sheet spells a practice, pointed at the Hub practice it means. A
          sheet row whose name matches nothing here or in HighLevel stays &ldquo;attached to no
          practice&rdquo; and doesn&rsquo;t count anywhere.
        </p>
        <form action={addAlias} className="mt-3 flex flex-wrap items-center gap-2">
          <input name="tracker_name" required placeholder="Name as the sheet writes it" className={input} />
          {clientSelect}
          <input name="note" placeholder="Note (optional)" className={input} />
          <button type="submit" className={button}>
            Add alias
          </button>
        </form>
        <table className="mt-4 w-full text-sm">
          <tbody>
            {(aliases.data ?? []).map((row) => (
              <tr key={row.tracker_name} className="border-t border-line">
                <td className="py-2 pr-4 text-fg">{row.tracker_name}</td>
                <td className="py-2 pr-4 text-fg-muted">→ {nameById.get(row.client_id) ?? row.client_id}</td>
                <td className="py-2 pr-4 text-xs text-fg-subtle">{row.note}</td>
                <td className="py-2 text-right">
                  <form action={removeAlias}>
                    <input type="hidden" name="tracker_name" value={row.tracker_name} />
                    <button type="submit" className={danger}>
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-8 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Campaign → practice</h2>
        <p className="mt-1 max-w-3xl text-xs text-fg-subtle">
          For Meta campaigns whose ad account is shared or whose ids arrive mixed up between
          practices. Most campaigns don&rsquo;t need a row: spend follows the ad account (Settings →
          Ad accounts).
        </p>
        <form action={addCampaignMap} className="mt-3 flex flex-wrap items-center gap-2">
          <input
            name="campaign_external_id"
            required
            inputMode="numeric"
            placeholder="Meta campaign id (digits)"
            className={input}
          />
          {clientSelect}
          <input name="note" placeholder="Note (optional)" className={input} />
          <button type="submit" className={button}>
            Add campaign
          </button>
        </form>
        <table className="mt-4 w-full text-sm">
          <tbody>
            {(campaigns.data ?? []).map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td className="numeric py-2 pr-4 text-fg">{row.campaign_external_id}</td>
                <td className="py-2 pr-4 text-fg-muted">
                  → {row.client_id ? (nameById.get(row.client_id) ?? row.practice_name) : row.practice_name}
                </td>
                <td className="py-2 pr-4 text-xs text-fg-subtle">{row.note}</td>
                <td className="py-2 text-right">
                  <form action={removeCampaignMap}>
                    <input type="hidden" name="id" value={row.id} />
                    <button type="submit" className={danger}>
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-8 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Internal and test accounts</h2>
        <p className="mt-1 max-w-3xl text-xs text-fg-subtle">
          Marked practices are left out of the tracker. To mark a real practice as churned, use
          its own page (status → churned); that also takes it out of the Windsor no-data warning.
        </p>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {allClients.map((client) => (
              <tr key={client.id} className="border-t border-line">
                <td className="py-2 pr-4 text-fg">
                  {client.name}
                  {client.is_active ? null : (
                    <span className="ml-2 text-xs text-fg-subtle">inactive</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-xs text-fg-muted">
                  {client.is_internal ? 'internal / test' : 'real practice'}
                </td>
                <td className="py-2 text-right">
                  <form action={setInternal}>
                    <input type="hidden" name="client_id" value={client.id} />
                    <input type="hidden" name="internal" value={client.is_internal ? 'false' : 'true'} />
                    <button type="submit" className={button}>
                      {client.is_internal ? 'Mark as real' : 'Mark internal'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
