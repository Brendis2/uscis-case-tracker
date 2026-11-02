-- Apply in the Supabase SQL editor. Row-level security is the account boundary.
create extension if not exists pgcrypto;

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  receipt_number text not null check (receipt_number ~ '^[A-Z]{3}[0-9]{10}$'),
  form_type text,
  status text not null,
  status_description text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  insights_opt_in boolean not null default false,
  unique(owner_id, receipt_number)
);

create table if not exists public.status_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null,
  status_description text,
  recorded_at timestamptz not null default now()
);

-- Grants let an owner share one case read-only with an existing portal user.
create table if not exists public.case_shares (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  created_at timestamptz not null default now(),
  unique(case_id, recipient_id),
  check(owner_id <> recipient_id)
);

create index if not exists cases_owner_updated_idx on public.cases(owner_id, updated_at desc);
create index if not exists status_events_case_time_idx on public.status_events(case_id, recorded_at desc);
alter table public.cases enable row level security;
alter table public.status_events enable row level security;
alter table public.case_shares enable row level security;
drop policy if exists "Owners manage their cases" on public.cases;
create policy "Owners manage their cases" on public.cases for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "Owners manage their status events" on public.status_events;
create policy "Owners manage their status events" on public.status_events for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "Shared users can read cases" on public.cases;
create policy "Shared users can read cases" on public.cases for select using (
  exists (select 1 from public.case_shares s where s.case_id = id and s.recipient_id = auth.uid())
);
drop policy if exists "Shared users can read status events" on public.status_events;
create policy "Shared users can read status events" on public.status_events for select using (
  exists (select 1 from public.case_shares s where s.case_id = status_events.case_id and s.recipient_id = auth.uid())
);
drop policy if exists "Participants can see grants" on public.case_shares;
create policy "Participants can see grants" on public.case_shares for select using (auth.uid() in (owner_id, recipient_id));
drop policy if exists "Owners create grants" on public.case_shares;
create policy "Owners create grants" on public.case_shares for insert with check (auth.uid() = owner_id and exists (select 1 from public.cases c where c.id = case_id and c.owner_id = auth.uid()));
drop policy if exists "Owners revoke grants" on public.case_shares;
create policy "Owners revoke grants" on public.case_shares for delete using (auth.uid() = owner_id);

create or replace function public.share_case_with_email(p_case_id uuid, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare recipient uuid;
begin
  if not exists (select 1 from public.cases c where c.id = p_case_id and c.owner_id = auth.uid()) then
    raise exception 'Case not found or not owned by you';
  end if;
  select u.id into recipient from auth.users u where lower(u.email) = lower(trim(p_email));
  if recipient is null then raise exception 'That person needs to create an account before you can share a case'; end if;
  if recipient = auth.uid() then raise exception 'You already have access to this case'; end if;
  insert into public.case_shares(case_id, owner_id, recipient_id, recipient_email)
    values(p_case_id, auth.uid(), recipient, lower(trim(p_email)))
    on conflict (case_id, recipient_id) do update set recipient_email = excluded.recipient_email;
  return recipient;
end; $$;
revoke all on function public.share_case_with_email(uuid, text) from public;
grant execute on function public.share_case_with_email(uuid, text) to authenticated;

-- Future insights should consume aggregates grouped by form and time interval,
-- only for rows where insights_opt_in is true. Never expose receipt numbers,
-- descriptions, account IDs, or low-count cohorts to analytics consumers.
