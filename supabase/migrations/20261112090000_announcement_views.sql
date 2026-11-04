-- Who has seen each announcement (pilot feedback, Nov 2026): recorded once per person, the first time the card is on
-- their screen. Separate from announcement_reads, which is the "Mark as read" choice behind the unread badge.
create table if not exists public.announcement_views (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  member_id       uuid not null references public.organisation_members (id) on delete cascade,
  seen_at         timestamptz not null default now(),
  primary key (announcement_id, member_id)
);
create index if not exists announcement_views_member_idx on public.announcement_views (member_id);
alter table public.announcement_views enable row level security;

-- Anyone who already marked an announcement read has seen it.
insert into public.announcement_views (announcement_id, member_id, seen_at)
select announcement_id, member_id, read_at from public.announcement_reads
on conflict do nothing;
