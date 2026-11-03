-- Web push (G1.01): each device a person turns push on for, and which notifications have been pushed.
create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  member_id       uuid not null,
  endpoint        text not null unique check (endpoint like 'https://%'),
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  foreign key (organisation_id, member_id) references public.organisation_members (organisation_id, id) on delete cascade
);
create index if not exists push_subscriptions_member_idx on public.push_subscriptions (member_id);
alter table public.push_subscriptions enable row level security;

alter table public.notifications add column if not exists pushed_at timestamptz;
-- Nothing already in people's bells gets pushed.
update public.notifications set pushed_at = created_at where pushed_at is null;
create index if not exists notifications_unpushed_idx on public.notifications (created_at) where pushed_at is null;
