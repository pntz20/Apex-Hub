-- 0109: a practice can have more than one stat sheet.
--
-- pps_clinic_routing is keyed by client and by HighLevel location, because Make
-- routing needs exactly one sheet per location. But Village Dental of New
-- England keeps its General Dentistry consults on a second stat sheet
-- (same location, same MASTER layout), so those shows never reached the Hub
-- and the PPS checks could not see them.
--
-- Extra sheets go in their own column so Make routing, the routing export and
-- the settings page keep their one-sheet-per-location meaning. Only the
-- stat-sheet sync reads it.

alter table public.pps_clinic_routing
  add column if not exists extra_spreadsheet_ids text[] not null default '{}';

comment on column public.pps_clinic_routing.extra_spreadsheet_ids is
  'Further stat sheets for this practice (same location), read by the stat-sheet sync only. Not used for Make routing.';

-- Village Dental of New England (General Dentistry) - Stat Sheet
update public.pps_clinic_routing
set extra_spreadsheet_ids = array['1I4kvfPX1EofH1YcbGyTOlS_CoQnDQAmlX3DtE0TE-j4'],
    updated_at = now()
where client_id = '7abfac71-2b5c-4ecc-854a-7f0042cc2073'
  and not ('1I4kvfPX1EofH1YcbGyTOlS_CoQnDQAmlX3DtE0TE-j4' = any(extra_spreadsheet_ids));
