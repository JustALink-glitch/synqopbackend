-- G1.03 Who has read each announcement, so the menu can show a "new" count until they mark it read.
create table if not exists public.announcement_reads (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  member_id       uuid not null references public.organisation_members (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, member_id)
);
create index if not exists announcement_reads_member_idx on public.announcement_reads (member_id);
alter table public.announcement_reads enable row level security;
