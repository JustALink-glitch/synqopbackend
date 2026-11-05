-- Zoom: classes at the same time and recordings (pilot feedback, Nov 2026).
--
-- zoom_connections.users: the licensed users in the organisation's Zoom account, refreshed daily, so each class can be
-- hosted by its trainer's own Zoom user or a free "room" user instead of everyone sharing the connected account.
alter table public.zoom_connections
  add column if not exists users jsonb not null default '[]'::jsonb,
  add column if not exists users_checked_at timestamptz;

-- zoom_host_id: the Zoom user who hosts the meeting (null: the connected account, as before).
-- recording_*: Zoom's cloud recording, linked (not copied) once Zoom has processed it.
alter table public.sessions
  add column if not exists zoom_host_id text,
  add column if not exists recording_url text,
  add column if not exists recording_passcode text,
  add column if not exists recording_minutes integer,
  add column if not exists recording_checked_at timestamptz,
  add column if not exists recording_status text check (recording_status in ('ready', 'none'));

-- Finding a free host: online Synqop meetings by host and time.
create index if not exists sessions_zoom_host_idx on public.sessions (organisation_id, zoom_host_id, starts_at) where zoom_managed;
