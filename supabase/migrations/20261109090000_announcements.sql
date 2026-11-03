-- G1.03 Announcements: admins post to everyone, staff, all participants or one cohort; trainers to cohorts they teach.
create table if not exists public.announcements (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations (id) on delete cascade,
  author_member_id uuid,
  audience         text not null check (audience in ('everyone', 'staff', 'participants', 'cohort')),
  cohort_id        uuid references public.cohorts (id) on delete cascade,
  title            text not null check (char_length(title) between 1 and 120),
  body             text not null check (char_length(body) between 1 and 4000),
  important        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check ((audience = 'cohort') = (cohort_id is not null)),
  foreign key (organisation_id, author_member_id) references public.organisation_members (organisation_id, id) on delete set null (author_member_id)
);
create index if not exists announcements_org_idx on public.announcements (organisation_id, created_at desc) where deleted_at is null;
create index if not exists announcements_cohort_idx on public.announcements (cohort_id) where cohort_id is not null;
alter table public.announcements enable row level security;
