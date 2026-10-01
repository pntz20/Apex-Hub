-- 0107: CFT step 16. When a booking was announced in #isr-wins.
--
-- Set by the booking-alerts sync after Slack accepts the post, so each booking
-- is announced once and a failed post is retried. Null for every existing row;
-- the sync only considers bookings made in the last three hours, so history is
-- never announced.

alter table public.appointments
  add column if not exists slack_alerted_at timestamptz;

create index if not exists appointments_slack_alert_pending
  on public.appointments (booked_at)
  where slack_alerted_at is null and source = 'crm';
