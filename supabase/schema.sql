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
create index if not exists case_shares_recipient_idx on public.case_shares(recipient_id, case_id);
create or replace function public.touch_case_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;
drop trigger if exists cases_touch_updated_at on public.cases;
create trigger cases_touch_updated_at before update on public.cases
for each row execute function public.touch_case_updated_at();
alter table public.cases enable row level security;
alter table public.status_events enable row level security;
alter table public.case_shares enable row level security;
drop policy if exists "Owners manage their cases" on public.cases;
create policy "Owners manage their cases" on public.cases for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "Owners manage their status events" on public.status_events;
create policy "Owners manage their status events" on public.status_events for all
using (
  auth.uid() = owner_id and exists (
    select 1 from public.cases c where c.id = status_events.case_id and c.owner_id = auth.uid()
  )
)
with check (
  auth.uid() = owner_id and exists (
    select 1 from public.cases c where c.id = status_events.case_id and c.owner_id = auth.uid()
  )
);
drop policy if exists "Shared users can read cases" on public.cases;
create policy "Shared users can read cases" on public.cases for select using (
  exists (select 1 from public.case_shares s where s.case_id = cases.id and s.recipient_id = auth.uid())
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

-- Store the current snapshot and append a timeline event atomically. A per-user
-- advisory lock prevents simultaneous refreshes from creating duplicate events.
create or replace function public.record_case_status(
  p_receipt_number text,
  p_form_type text,
  p_status text,
  p_status_description text
)
returns uuid language plpgsql set search_path = '' as $$
declare
  user_id uuid := auth.uid();
  prior_status text;
  saved_case_id uuid;
begin
  if user_id is null then raise exception 'Sign in required'; end if;
  if p_receipt_number !~ '^[A-Z]{3}[0-9]{10}$' then raise exception 'Invalid receipt number'; end if;
  if p_status is null or length(trim(p_status)) = 0 then raise exception 'Status is required'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(user_id::text || ':' || p_receipt_number, 0)
  );
  select c.status into prior_status from public.cases c
    where c.owner_id = user_id and c.receipt_number = p_receipt_number for update;

  insert into public.cases(owner_id, receipt_number, form_type, status, status_description, checked_at)
    values(user_id, p_receipt_number, p_form_type, p_status, p_status_description, now())
    on conflict (owner_id, receipt_number) do update set
      form_type = excluded.form_type,
      status = excluded.status,
      status_description = excluded.status_description,
      checked_at = now()
    returning id into saved_case_id;

  if prior_status is null or prior_status is distinct from p_status then
    insert into public.status_events(case_id, owner_id, status, status_description, recorded_at)
      values(saved_case_id, user_id, p_status, p_status_description, now());
  end if;
  return saved_case_id;
end; $$;
revoke all on function public.record_case_status(text, text, text, text) from public;
grant execute on function public.record_case_status(text, text, text, text) to authenticated;

-- Future insights should consume aggregates grouped by form and time interval,
-- only for rows where insights_opt_in is true. Never expose receipt numbers,
-- descriptions, account IDs, or low-count cohorts to analytics consumers.
