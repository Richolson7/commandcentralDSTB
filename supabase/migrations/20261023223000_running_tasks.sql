-- Running list for the Command Center (separate from L10 tasks).
--
-- Existing public tables such as dashboard_data, tasks, driven_tasks, and
-- l10_state allow the anon key to read and write. This migration does not
-- change those policies or any existing rows.
--
-- running_tasks and running_schedule_settings are private. Row Level Security
-- is forced on, anon has no privileges, and authenticated users can touch only
-- rows where user_id = auth.uid(). Personal Life OS tasks are not world-readable.
--
-- Starter tasks cannot be inserted here: there is no auth user yet, and every
-- row must belong to one. seed_running_tasks() inserts them on first sign-in.
-- It is idempotent (skips titles that already exist, then sets seeds_applied).

create table if not exists public.running_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  notes text not null default '',
  due_date date,
  status text not null default 'todo',
  category text not null default 'work',
  business text,
  estimate_minutes integer not null default 30,
  priority smallint not null default 2,
  sort_order integer not null default 0,
  pin_date date,
  pin_start_minute integer,
  placement text not null default 'auto',
  weekend_scheduled boolean not null default false,
  revenue boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint running_tasks_title_len check (char_length(title) between 1 and 300),
  constraint running_tasks_notes_len check (char_length(notes) <= 8000),
  constraint running_tasks_status_chk check (status in ('todo', 'in_progress', 'done')),
  constraint running_tasks_category_chk check (
    (category = 'personal' and business is null)
    or (category = 'work' and (business is null or business in ('driven', 'trailblazers', 'ground_up')))
  ),
  constraint running_tasks_estimate_chk check (estimate_minutes between 5 and 720),
  constraint running_tasks_priority_chk check (priority between 1 and 3),
  constraint running_tasks_pin_minute_chk check (pin_start_minute is null or pin_start_minute between 0 and 1439),
  constraint running_tasks_placement_chk check (
    (placement = 'auto' and pin_date is null and pin_start_minute is null)
    or (placement = 'overflow' and pin_date is not null and pin_start_minute is null)
    or (placement = 'window' and pin_date is not null and pin_start_minute is not null)
  )
);

create table if not exists public.running_schedule_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  work_windows jsonb not null default '{
    "0": {"enabled": false, "start": "06:00", "end": "20:00"},
    "1": {"enabled": true, "start": "06:00", "end": "20:00"},
    "2": {"enabled": true, "start": "06:00", "end": "20:00"},
    "3": {"enabled": true, "start": "06:00", "end": "20:00"},
    "4": {"enabled": true, "start": "06:00", "end": "20:00"},
    "5": {"enabled": true, "start": "06:00", "end": "20:00"},
    "6": {"enabled": false, "start": "06:00", "end": "20:00"}
  }'::jsonb,
  manual_blocks jsonb not null default '[]'::jsonb,
  focus_keywords text not null default 'Focus, Work block, Tasks',
  min_gap_minutes integer not null default 15,
  ignore_all_day boolean not null default true,
  ignore_transparent boolean not null default true,
  timezone text not null default 'America/Chicago',
  seeds_applied boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint running_schedule_windows_obj check (jsonb_typeof(work_windows) = 'object'),
  constraint running_schedule_blocks_arr check (jsonb_typeof(manual_blocks) = 'array'),
  constraint running_schedule_gap_chk check (min_gap_minutes between 0 and 240),
  constraint running_schedule_tz_len check (char_length(timezone) between 1 and 80)
);

create index if not exists running_tasks_user_status_sort_idx
  on public.running_tasks (user_id, status, sort_order);

create index if not exists running_tasks_user_due_idx
  on public.running_tasks (user_id, due_date);

create or replace function public.set_running_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists running_tasks_updated_at on public.running_tasks;
create trigger running_tasks_updated_at
  before update on public.running_tasks
  for each row execute function public.set_running_updated_at();

drop trigger if exists running_schedule_settings_updated_at on public.running_schedule_settings;
create trigger running_schedule_settings_updated_at
  before update on public.running_schedule_settings
  for each row execute function public.set_running_updated_at();

revoke all on function public.set_running_updated_at() from public, anon;
grant execute on function public.set_running_updated_at() to authenticated;

alter table public.running_tasks enable row level security;
alter table public.running_tasks force row level security;
alter table public.running_schedule_settings enable row level security;
alter table public.running_schedule_settings force row level security;

revoke all on table public.running_tasks from public, anon;
revoke all on table public.running_schedule_settings from public, anon;
grant select, insert, update, delete on table public.running_tasks to authenticated;
grant select, insert, update, delete on table public.running_schedule_settings to authenticated;
-- Default privileges can leave TRUNCATE, which ignores RLS and would wipe every login.
revoke truncate, trigger, references on table public.running_tasks from authenticated;
revoke truncate, trigger, references on table public.running_schedule_settings from authenticated;

drop policy if exists running_tasks_owner on public.running_tasks;
create policy running_tasks_owner
  on public.running_tasks
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists running_schedule_settings_owner on public.running_schedule_settings;
create policy running_schedule_settings_owner
  on public.running_schedule_settings
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Estimates: Finance department 3h, Ground Up email 1h, Other weekend tasks 1h.
-- All three are Work, To Do, due Sunday 2026-10-25, and explicitly kept on the weekend.
create or replace function public.seed_running_tasks()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted integer := 0;
begin
  if (select auth.uid()) is null then
    return 0;
  end if;

  insert into public.running_schedule_settings (user_id)
  values ((select auth.uid()))
  on conflict (user_id) do nothing;

  if exists (
    select 1 from public.running_schedule_settings
    where user_id = (select auth.uid()) and seeds_applied
  ) then
    return 0;
  end if;

  insert into public.running_tasks (
    user_id, title, notes, due_date, status, category, business,
    estimate_minutes, priority, weekend_scheduled, revenue
  )
  select
    (select auth.uid()),
    seed.title,
    seed.notes,
    date '2026-10-25',
    'todo',
    'work',
    seed.business,
    seed.estimate_minutes,
    2,
    true,
    false
  from (
    values
      (
        'Finance department',
        'Get the finance work done this weekend (Driven + Trailblazers books/finance).',
        null::text,
        180
      ),
      (
        'Get email for The Ground Up',
        'Start/set up email for The Ground Up coaching brand.',
        'ground_up',
        60
      ),
      (
        'Other weekend tasks',
        'Catch-all for anything else this weekend - fill in.',
        null::text,
        60
      )
  ) as seed(title, notes, business, estimate_minutes)
  where not exists (
    select 1 from public.running_tasks existing
    where existing.user_id = (select auth.uid())
      and existing.title = seed.title
  );

  get diagnostics inserted = row_count;

  update public.running_schedule_settings
  set seeds_applied = true
  where user_id = (select auth.uid());

  return inserted;
end;
$$;

revoke all on function public.seed_running_tasks() from public, anon;
grant execute on function public.seed_running_tasks() to authenticated;

alter table public.running_tasks replica identity full;
alter table public.running_schedule_settings replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'running_tasks'
    ) then
      alter publication supabase_realtime add table public.running_tasks;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'running_schedule_settings'
    ) then
      alter publication supabase_realtime add table public.running_schedule_settings;
    end if;
  end if;
end $$;

comment on table public.running_tasks is
  'Command Center running list. Private to auth.uid(). Not the L10 tasks list.';
comment on table public.running_schedule_settings is
  'Per-user work windows, manual time blocks, and calendar gap rules for the running list.';

notify pgrst, 'reload schema';
