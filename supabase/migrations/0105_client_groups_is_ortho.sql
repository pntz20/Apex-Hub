-- Which practices are orthodontic.
--
-- The client portal's FAQ answers questions only an ortho practice asks (lead
-- time before a consult, the $25 Invisalign-style deposit, insurance checks),
-- so it is shown only where this is true. Nothing else in the schema said what
-- kind of practice a group is: treatments is empty on every row.
--
-- Backfilled from the name because every ortho client so far says so in it.
-- Practices that do ortho without the word (The Smile Patio, say) are ticked by
-- hand in the client editor.

alter table public.client_groups
  add column if not exists is_ortho boolean not null default false;

update public.client_groups
   set is_ortho = true
 where name ~* '\mortho';
