import type { BookingRow } from '@/components/clients/BookingsTable';
import { tenant } from '@/config/tenant.config';
import type { serviceClient } from '@/lib/supabase/service';

/**
 * The tracker's Bookings view (CFT step 13): one row per appointment booked
 * in the window, with its date AND time.
 *
 * The SOP's "Appointment Data" tab lists every booking with its start date
 * and time. The tracker only ever showed counts, and its sheet feed carries
 * the date alone, so the time existed in the Hub (appointments.scheduled_at,
 * 1,448 of 1,448 rows on 29 Sep 2026) without being shown anywhere a
 * fulfilment person looks.
 *
 * Rows are chosen by booked_at, the same event the Appointments card counts,
 * so the list and the card above it describe the same bookings. Each row is
 * rendered in its own practice's timezone, as BookingsTable does elsewhere.
 * Internal and test locations are left out, as they are from the tracker.
 */
export const BOOKINGS_LIMIT = 500;

export async function loadTrackerBookings(
  db: ReturnType<typeof serviceClient>,
  { from, to, clientId }: { from: string; to: string; clientId?: string },
): Promise<{ rows: BookingRow[]; truncated: boolean }> {
  const clientsQuery = db.from('clients').select('id, name, timezone, is_internal');
  const { data: clients, error: clientsError } = clientId
    ? await clientsQuery.eq('id', clientId)
    : await clientsQuery;
  if (clientsError) throw clientsError;

  const owners = new Map(
    (clients ?? [])
      .filter((client) => !client.is_internal)
      .map((client) => [client.id, client]),
  );
  if (owners.size === 0) return { rows: [], truncated: false };

  // booked_at is a timestamp; the window is whole days, inclusive of `to`.
  const { data, error } = await db
    .from('appointments')
    // One unbroken literal, so Supabase can infer the row type from it.
    .select(
      'id, client_id, patient_name, patient_phone, address, scheduled_at, status, showed, outcome, value_cents, booked_by_name, attribution_source, utm_campaign, notes, reschedule_count',
    )
    .in('client_id', [...owners.keys()])
    .gte('booked_at', `${from}T00:00:00Z`)
    .lte('booked_at', `${to}T23:59:59.999Z`)
    .order('scheduled_at', { ascending: false })
    .limit(BOOKINGS_LIMIT + 1);
  if (error) throw error;

  const list = data ?? [];
  const rows: BookingRow[] = list.slice(0, BOOKINGS_LIMIT).map((row) => {
    const owner = owners.get(row.client_id);
    return {
      ...row,
      locationName: owner?.name ?? 'Unknown',
      timezone: owner?.timezone ?? tenant.defaultTimezone,
    };
  });

  return { rows, truncated: list.length > BOOKINGS_LIMIT };
}
