-- Pilot feedback (Nov 2026): an organisation logo, shown in the sidebar. Stored in the private files bucket.
alter table public.organisations add column if not exists logo_path text;
