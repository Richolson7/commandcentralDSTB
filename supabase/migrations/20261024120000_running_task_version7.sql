-- Adds the Life OS task "Version 7 comes out this week" to the first-sign-in seed.
--
-- Review only. Do not apply this against production from the agent.
-- running_tasks rows need auth.uid(), and Rich has no login yet, so this
-- does not insert a row and does not use a stand-in user id.
--
-- The three weekend starters stay as they are. If a login already ran the
-- earlier seed, the next sign-in still inserts this title when it is missing.
-- It does not reset seeds_applied and does not copy L10 tasks.

create or replace function public.seed_running_tasks()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted integer := 0;
  added integer := 0;
begin
  if (select auth.uid()) is null then
    return 0;
  end if;

  insert into public.running_schedule_settings (user_id)
  values ((select auth.uid()))
  on conflict (user_id) do nothing;

  if not exists (
    select 1 from public.running_schedule_settings
    where user_id = (select auth.uid()) and seeds_applied
  ) then
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
  end if;

  insert into public.running_tasks (
    user_id, title, notes, due_date, status, category, business,
    estimate_minutes, priority, weekend_scheduled, revenue
  )
  select
    (select auth.uid()),
    'Version 7 comes out this week',
    'Watch item only, no other action. The v7 doc''s dates run late June-early Aug; nothing in it says this week. v7 = hosted, sellable Life OS app (Ground Up revenue).',
    date '2026-10-30',
    'todo',
    'personal',
    null,
    30,
    2,
    false,
    false
  where not exists (
    select 1 from public.running_tasks existing
    where existing.user_id = (select auth.uid())
      and existing.title = 'Version 7 comes out this week'
  );

  get diagnostics added = row_count;
  return inserted + added;
end;
$$;

revoke all on function public.seed_running_tasks() from public, anon;
grant execute on function public.seed_running_tasks() to authenticated;
