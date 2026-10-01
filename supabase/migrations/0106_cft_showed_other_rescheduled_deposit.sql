-- 0106: CFT step 14. Showed - Other, Rescheduled and Deposit paid.
--
-- The SOP's post-appointment survey records three things the tracker did not
-- show. All three are appended to v_cft_stats_dashboard (same columns, order
-- and types as 0101 before them, so nothing that reads the view breaks):
--
--   showed_other   a show with no Closed / DQ / Follow up result. On HighLevel-
--                  only bookings DQ and Follow up are not recorded anywhere, so
--                  a show there is "other" unless the stat sheet says it closed.
--   rescheduled    the ledger row replaces an earlier booking (reschedule_of),
--                  or HighLevel moved the appointment (reschedule_count > 0).
--   deposits_paid  appointments.deposit_collected, written by the consultation
--                  outcome webhook / portal form. Empty today (0 of 1,467):
--                  the column will read 0 until outcomes are recorded there.
--
-- Approved by Josh, 1 Oct 2026.

create or replace view public.v_cft_stats_dashboard as
 WITH own AS (
         SELECT DISTINCT campaigns.client_id,
            campaigns.external_id
           FROM campaigns
          WHERE campaigns.external_id IS NOT NULL
        ), ins AS (
         SELECT i_1.client_id,
            cmp_1.external_id AS campaign_external_id,
            i_1.insight_on AS day,
            sum(i_1.spend_cents) AS spend_cents,
            sum(i_1.impressions) AS impressions,
            sum(i_1.clicks) AS clicks,
            sum(i_1.leads) AS leads_windsor
           FROM ad_level_insights i_1
             JOIN campaigns cmp_1 ON cmp_1.id = i_1.campaign_id
          WHERE i_1.client_id IS NOT NULL
          GROUP BY i_1.client_id, cmp_1.external_id, i_1.insight_on
        ), top_month AS (
         SELECT DISTINCT ON (m.client_id, m.month) m.client_id,
            m.month,
            m.campaign_external_id
           FROM ( SELECT ins.client_id,
                    ins.campaign_external_id,
                    date_trunc('month'::text, ins.day::timestamp with time zone)::date AS month,
                    sum(ins.spend_cents) AS spend
                   FROM ins
                  GROUP BY ins.client_id, ins.campaign_external_id, (date_trunc('month'::text, ins.day::timestamp with time zone)::date)) m
          ORDER BY m.client_id, m.month, m.spend DESC, m.campaign_external_id
        ), top_ever AS (
         SELECT DISTINCT ON (a_1.client_id) a_1.client_id,
            a_1.campaign_external_id
           FROM ( SELECT ins.client_id,
                    ins.campaign_external_id,
                    sum(ins.spend_cents) AS spend
                   FROM ins
                  GROUP BY ins.client_id, ins.campaign_external_id) a_1
          ORDER BY a_1.client_id, a_1.spend DESC, a_1.campaign_external_id
        ), crm AS (
         SELECT DISTINCT ON (appointments.client_id, appointments.crm_appointment_id) appointments.client_id,
            appointments.crm_appointment_id,
            appointments.campaign_external_id,
            appointments.booked_at,
            COALESCE(appointments.reschedule_count, 0) > 0 AS crm_rescheduled,
            COALESCE(appointments.deposit_collected, false) AS crm_deposit,
            lower(NULLIF(btrim(appointments.patient_email), ''::text)) AS patient_email_key,
            NULLIF(lower(regexp_replace(COALESCE(appointments.patient_name, ''::text), '[^a-zA-Z]'::text, ''::text, 'g'::text)), ''::text) AS patient_name_key
           FROM appointments
          WHERE appointments.crm_appointment_id IS NOT NULL
          ORDER BY appointments.client_id, appointments.crm_appointment_id, appointments.campaign_external_id
        ), sheet_patients AS (
         SELECT t.client_id,
            lower(NULLIF(btrim(t.patient_email), ''::text)) AS patient_email_key,
            NULLIF(lower(regexp_replace(COALESCE(t.patient_name, ''::text), '[^a-zA-Z]'::text, ''::text, 'g'::text)), ''::text) AS patient_name_key,
            COALESCE(t.created_on, t.booked_for) AS sheet_day,
            t.booked_for
           FROM tracker_appointments t
          WHERE t.client_id IS NOT NULL
        ), tv AS (
         SELECT stat_sheet_appointments.appointment_external_id AS crm_appointment_id,
            max(stat_sheet_appointments.treatment_value_cents)::integer AS treatment_value_cents
           FROM stat_sheet_appointments
          WHERE stat_sheet_appointments.appointment_external_id IS NOT NULL AND stat_sheet_appointments.treatment_value_cents > 0
          GROUP BY stat_sheet_appointments.appointment_external_id
        ), ss AS (
         SELECT s.appointment_external_id AS crm_appointment_id,
            bool_or(upper("left"(btrim(s.first_consultation_show), 1)) = 'Y'::text) AS ss_show,
            bool_or(upper("left"(btrim(s.first_consultation_show), 1)) = 'N'::text) AS ss_no_show,
            bool_or(upper("left"(btrim(s.first_consultation_show), 1)) = 'C'::text) AS ss_cancel,
            bool_or(lower(btrim(s.converted_to_patient)) = ANY (ARRAY['yes'::text, 'y'::text])) AS ss_close
           FROM stat_sheet_appointments s
          WHERE s.appointment_external_id IS NOT NULL
          GROUP BY s.appointment_external_id
        ), lg AS (
         SELECT l_1.id,
            l_1.client_id,
            l_1.crm_appointment_id,
            l_1.hp_appointment_id,
            l_1.tracker_source_tab,
            l_1.tracker_source_row,
            l_1.patient_name,
            l_1.patient_email,
            l_1.patient_phone,
            l_1.source,
            l_1.raw_disposition,
            l_1.booked_at,
            l_1.booked_by_name,
            l_1.appointment_at,
            l_1.dispositioned_at,
            l_1.calendar_seen_at,
            l_1.reschedule_of,
            l_1.attempt_number,
            l_1.confirmed_at,
            l_1.confirmation_channel,
            l_1.outcome,
            l_1.outcome_source,
            l_1.outcome_at,
            l_1.outcome_due_at,
            l_1.outcome_defaulted,
            l_1.cancelled_at,
            l_1.cancellation_reason,
            l_1.cancelled_by,
            l_1.last_seen_in_crm_at,
            l_1.missing_since,
            l_1.client_calendar_state,
            l_1.client_calendar_checked_at,
            l_1.seen_in,
            l_1.billing_state,
            l_1.billing_hold_reason,
            l_1.billed_at,
            l_1.stripe_payment_intent_id,
            l_1.amount_cents,
            l_1.created_at,
            l_1.updated_at,
            a_1.campaign_external_id AS appt_campaign,
            COALESCE(a_1.crm_rescheduled, false) AS crm_rescheduled,
            COALESCE(a_1.crm_deposit, false) AS crm_deposit,
            COALESCE((a_1.booked_at AT TIME ZONE 'UTC'::text)::date, (l_1.booked_at AT TIME ZONE 'UTC'::text)::date, (l_1.appointment_at AT TIME ZONE 'UTC'::text)::date) AS booked_day,
            (l_1.appointment_at AT TIME ZONE 'UTC'::text)::date AS visit_day
           FROM appointment_ledger l_1
             LEFT JOIN crm a_1 ON a_1.client_id = l_1.client_id AND a_1.crm_appointment_id = l_1.crm_appointment_id
          WHERE l_1.client_id IS NOT NULL AND l_1.tracker_source_row IS NULL AND l_1.appointment_at IS NOT NULL
            AND NOT (EXISTS ( SELECT 1
                   FROM sheet_patients sp
                  WHERE sp.client_id = l_1.client_id
                    AND (sp.patient_email_key = COALESCE(a_1.patient_email_key, lower(NULLIF(btrim(l_1.patient_email), ''::text)))
                      OR sp.patient_name_key = COALESCE(a_1.patient_name_key, NULLIF(lower(regexp_replace(COALESCE(l_1.patient_name, ''::text), '[^a-zA-Z]'::text, ''::text, 'g'::text)), ''::text)))
                    AND (abs(sp.sheet_day - COALESCE((a_1.booked_at AT TIME ZONE 'UTC'::text)::date, (l_1.booked_at AT TIME ZONE 'UTC'::text)::date, (l_1.appointment_at AT TIME ZONE 'UTC'::text)::date)) <= 31
                      OR abs(sp.booked_for - (l_1.appointment_at AT TIME ZONE 'UTC'::text)::date) <= 31)))
        ), lds AS (
         SELECT l_1.client_id,
                CASE
                    WHEN o_1.external_id IS NOT NULL THEN l_1.campaign_external_id
                    ELSE COALESCE(tm.campaign_external_id, te.campaign_external_id)
                END AS campaign_external_id,
            l_1.received_on AS day,
            sum(COALESCE(l_1.lead_count, 1)) AS leads_tracker
           FROM v_tracker_leads_effective l_1
             LEFT JOIN own o_1 ON o_1.client_id = l_1.client_id AND o_1.external_id = l_1.campaign_external_id
             LEFT JOIN top_month tm ON tm.client_id = l_1.client_id AND tm.month = date_trunc('month'::text, l_1.received_on::timestamp with time zone)::date
             LEFT JOIN top_ever te ON te.client_id = l_1.client_id
          WHERE l_1.client_id IS NOT NULL
          GROUP BY l_1.client_id, (
                CASE
                    WHEN o_1.external_id IS NOT NULL THEN l_1.campaign_external_id
                    ELSE COALESCE(tm.campaign_external_id, te.campaign_external_id)
                END), l_1.received_on
        ), ta AS (
         SELECT t.id,
            t.source_row,
            t.location_name,
            t.client_id,
            t.patient_name,
            t.patient_email,
            t.created_on,
            t.booked_for,
            t.campaign_external_id,
            t.adset_external_id,
            t.ad_external_id,
            t.offer_name,
            t.appointment_status,
            t.status_if_showed,
            t.amount_spent_cents,
            t.imported_at,
            t.booked_by,
                CASE
                    WHEN o_1.external_id IS NOT NULL THEN t.campaign_external_id
                    ELSE COALESCE(tm.campaign_external_id, te.campaign_external_id)
                END AS resolved_campaign
           FROM tracker_appointments t
             LEFT JOIN own o_1 ON o_1.client_id = t.client_id AND o_1.external_id = t.campaign_external_id
             LEFT JOIN top_month tm ON tm.client_id = t.client_id AND tm.month = date_trunc('month'::text, COALESCE(t.created_on, t.booked_for)::timestamp with time zone)::date
             LEFT JOIN top_ever te ON te.client_id = t.client_id
          WHERE t.client_id IS NOT NULL
        ), appt_src AS (
         SELECT t.client_id,
            t.resolved_campaign AS campaign_external_id,
            COALESCE(t.created_on, t.booked_for) AS day,
            t.booked_for,
            true AS from_tracker,
            t.appointment_status IS NULL AS is_pending,
            t.appointment_status = 'Showed'::text AS is_show,
            t.appointment_status = 'No Show'::text AS is_no_show,
            t.status_if_showed = 'DQ'::text AS is_dq,
            t.status_if_showed = 'Closed'::text AS is_close,
            t.status_if_showed = 'Follow up'::text AS is_follow_up,
            l_1.cancelled_at IS NOT NULL AS is_cancel,
            l_1.id IS NULL AS not_in_ledger,
            tv.treatment_value_cents AS revenue_cents,
            l_1.reschedule_of IS NOT NULL OR COALESCE(c_1.crm_rescheduled, false) AS is_rescheduled,
            COALESCE(c_1.crm_deposit, false) AS is_deposit
           FROM ta t
             LEFT JOIN appointment_ledger l_1 ON l_1.client_id = t.client_id AND l_1.tracker_source_row = t.source_row
             LEFT JOIN crm c_1 ON c_1.client_id = l_1.client_id AND c_1.crm_appointment_id = l_1.crm_appointment_id
             LEFT JOIN tv ON tv.crm_appointment_id = l_1.crm_appointment_id
        UNION ALL
         SELECT l_1.client_id,
                CASE
                    WHEN o_1.external_id IS NOT NULL THEN l_1.appt_campaign
                    ELSE COALESCE(tm.campaign_external_id, te.campaign_external_id)
                END AS "coalesce",
            l_1.booked_day,
            l_1.visit_day,
            false,
            l_1.outcome = 'pending'::ledger_outcome AND NOT COALESCE(ss.ss_show OR ss.ss_no_show OR ss.ss_cancel, false),
            l_1.outcome = 'showed'::ledger_outcome OR l_1.outcome = 'pending'::ledger_outcome AND COALESCE(ss.ss_show, false),
            l_1.outcome = 'no_show'::ledger_outcome OR l_1.outcome = 'pending'::ledger_outcome AND COALESCE(ss.ss_no_show AND NOT ss.ss_show, false),
            false,
            COALESCE(ss.ss_close, false),
            false,
            l_1.cancelled_at IS NOT NULL OR l_1.outcome = 'pending'::ledger_outcome AND COALESCE(ss.ss_cancel AND NOT ss.ss_show AND NOT ss.ss_no_show, false),
            false,
            tv.treatment_value_cents,
            l_1.reschedule_of IS NOT NULL OR l_1.crm_rescheduled,
            l_1.crm_deposit
           FROM lg l_1
             LEFT JOIN tv ON tv.crm_appointment_id = l_1.crm_appointment_id
             LEFT JOIN ss ON ss.crm_appointment_id = l_1.crm_appointment_id
             LEFT JOIN own o_1 ON o_1.client_id = l_1.client_id AND o_1.external_id = l_1.appt_campaign
             LEFT JOIN top_month tm ON tm.client_id = l_1.client_id AND tm.month = date_trunc('month'::text, l_1.booked_day::timestamp with time zone)::date
             LEFT JOIN top_ever te ON te.client_id = l_1.client_id
        ), appt AS (
         SELECT appt_src.client_id,
            appt_src.campaign_external_id,
            appt_src.day,
            count(*) AS appts_created,
            count(*) FILTER (WHERE appt_src.from_tracker) AS appts_tracker,
            count(*) FILTER (WHERE appt_src.is_pending) AS appts_pending,
            max(appt_src.booked_for) AS last_appt_date,
            count(*) FILTER (WHERE appt_src.is_show) AS shows,
            count(*) FILTER (WHERE appt_src.is_no_show) AS no_shows,
            count(*) FILTER (WHERE appt_src.is_dq) AS dqs,
            count(*) FILTER (WHERE appt_src.is_close) AS closes,
            count(*) FILTER (WHERE appt_src.is_follow_up) AS follow_ups,
            count(*) FILTER (WHERE appt_src.is_cancel) AS cancels,
            count(*) FILTER (WHERE appt_src.not_in_ledger) AS appts_not_in_ledger,
            sum(COALESCE(appt_src.revenue_cents, 0)) AS revenue_cents,
            count(*) FILTER (WHERE appt_src.is_show AND NOT (appt_src.is_close OR appt_src.is_dq OR appt_src.is_follow_up)) AS showed_other,
            count(*) FILTER (WHERE appt_src.is_rescheduled) AS rescheduled,
            count(*) FILTER (WHERE appt_src.is_deposit) AS deposits_paid
           FROM appt_src
          GROUP BY appt_src.client_id, appt_src.campaign_external_id, appt_src.day
        ), ofr AS (
         SELECT ta.client_id,
            ta.resolved_campaign AS campaign_external_id,
            mode() WITHIN GROUP (ORDER BY ta.offer_name) AS offer_name
           FROM ta
          WHERE ta.offer_name IS NOT NULL
          GROUP BY ta.client_id, ta.resolved_campaign
        ), spine AS (
         SELECT ins.client_id,
            ins.campaign_external_id,
            ins.day
           FROM ins
        UNION
         SELECT lds.client_id,
            lds.campaign_external_id,
            lds.day
           FROM lds
        UNION
         SELECT appt.client_id,
            appt.campaign_external_id,
            appt.day
           FROM appt
        )
 SELECT NULL::text AS notes,
        CASE
            WHEN g.status = 'churned'::client_status THEN 'Churned'::text
            WHEN cl.is_active THEN 'Active'::text
            ELSE 'Paused'::text
        END AS status,
    cl.name AS client_name,
    cmp.name AS campaign_name,
    s.campaign_external_id AS campaign_id_external,
    o.offer_name,
    s.client_id,
    cl.group_id,
    cl.is_active,
    cmp.id AS campaign_uuid,
    cmp.status AS campaign_status,
    s.day,
    COALESCE(i.spend_cents, 0::bigint) AS spend_cents,
    COALESCE(i.impressions, 0::bigint) AS impressions,
    COALESCE(i.clicks, 0::bigint) AS clicks,
    COALESCE(i.leads_windsor, 0::bigint) AS leads_windsor,
    COALESCE(l.leads_tracker, 0::bigint) AS leads_tracker,
    GREATEST(COALESCE(i.leads_windsor, 0::bigint), COALESCE(l.leads_tracker, 0::bigint)) AS leads_best,
    COALESCE(a.appts_created, 0::bigint) AS appts_created,
    COALESCE(a.appts_pending, 0::bigint) AS appts_to_be_taken,
    a.last_appt_date,
    COALESCE(a.shows, 0::bigint) AS shows,
    COALESCE(a.no_shows, 0::bigint) AS no_shows,
    COALESCE(a.cancels, 0::bigint) AS cancels,
    COALESCE(a.dqs, 0::bigint) AS dqs,
    COALESCE(a.follow_ups, 0::bigint) AS follow_ups,
    COALESCE(a.appts_not_in_ledger, 0::bigint) AS appts_not_in_ledger,
    COALESCE(a.closes, 0::bigint) AS closes,
    NULLIF(COALESCE(a.revenue_cents, 0::bigint), 0) AS revenue_cents,
    COALESCE(a.appts_tracker, 0::bigint) AS appts_tracker,
    COALESCE(a.showed_other, 0::bigint) AS showed_other,
    COALESCE(a.rescheduled, 0::bigint) AS rescheduled,
    COALESCE(a.deposits_paid, 0::bigint) AS deposits_paid
   FROM spine s
     JOIN clients cl ON cl.id = s.client_id
     LEFT JOIN client_groups g ON g.id = cl.group_id
     LEFT JOIN campaigns cmp ON cmp.client_id = s.client_id AND NOT cmp.external_id IS DISTINCT FROM s.campaign_external_id
     LEFT JOIN ins i ON i.client_id = s.client_id AND NOT i.campaign_external_id IS DISTINCT FROM s.campaign_external_id AND i.day = s.day
     LEFT JOIN lds l ON l.client_id = s.client_id AND NOT l.campaign_external_id IS DISTINCT FROM s.campaign_external_id AND l.day = s.day
     LEFT JOIN appt a ON a.client_id = s.client_id AND NOT a.campaign_external_id IS DISTINCT FROM s.campaign_external_id AND a.day = s.day
     LEFT JOIN ofr o ON o.client_id = s.client_id AND NOT o.campaign_external_id IS DISTINCT FROM s.campaign_external_id
  WHERE NOT cl.is_internal;
