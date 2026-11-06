-- Driven Finance Desk — read path and append-only notes.
-- Run this once in the Supabase SQL editor for project igaylyhkssahczubiztb.
-- It does not DROP, ALTER, UPDATE, or DELETE existing tables or rows.
-- It does not read or write fin_config or dashboard_data.
-- It does not send email.
--
-- What a human runs: this entire file.
-- After it succeeds, the Command Center Finance Desk can:
--   select public.fin_portal_read();
--   select public.fin_portal_append('portal_draft', '{"vendor":"Example","subject":"Draft","body":"Not sent"}'::jsonb);
--
-- fin_portal_append only INSERTs a new fin_log_history row.
-- Allowed actions: portal_contact, portal_draft, portal_pay_date, portal_autopay_note.
-- It cannot write QuickBooks snapshots and it forces email_sent = false.
--
-- Example shape of a source snapshot already stored in fin_log_history.payload
-- (do not treat this comment as a second set of books):
-- {
--   "source": "Driven Solutions QBO read-only",
--   "report_date": "YYYY-MM-DD",
--   "qbo_as_of_central": "ISO-8601",
--   "confirmation_status": "pending Amber; not bank-available cash",
--   "qbo_bank_cash": 0,
--   "amber_actual_cash": null,
--   "amber_last_known_gross_bank_unmapped": 0,
--   "ar_open_invoices": 0,
--   "ap_open_bills": 0,
--   "ap_aging": {"current_including_future": 0, "31_45": 0, "46_60": 0, "61_plus": 0},
--   "red_vendors": [{"vendor": "", "past_45": 0, "oldest_bill": null, "last_contact": null, "proposed_pay_date": null}],
--   "bills": [{"bill_id": "", "vendor": "", "bill_date": "YYYY-MM-DD", "open_balance": 0, "age_days": 0}],
--   "due_next_14d": null
-- }

create or replace function public.fin_portal_read()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'timezone', 'America/Chicago',
    'snapshots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'action', s.action,
        'week_of', s.week_of,
        'logged_at', s.logged_at,
        'payload', s.payload
      ) order by s.logged_at desc, s.id desc)
      from (
        select id, action, week_of, logged_at, payload
        from public.fin_log_history
        order by logged_at desc, id desc
        limit 40
      ) s
    ), '[]'::jsonb)
  );
$$;

create or replace function public.fin_portal_append(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id bigint;
  wk date;
  clean jsonb;
begin
  if p_action not in ('portal_contact', 'portal_draft', 'portal_pay_date', 'portal_autopay_note') then
    raise exception 'action not allowed';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be an object';
  end if;
  if octet_length(p_payload::text) > 12000 then
    raise exception 'payload too large';
  end if;

  clean := p_payload - 'send' - 'send_email' - 'deliver' - 'email_sent' - 'status';
  clean := clean || jsonb_build_object(
    'recorded_via', 'finance_desk',
    'email_sent', false
  );
  if p_action = 'portal_draft' then
    clean := clean || jsonb_build_object('status', 'draft');
  end if;

  wk := (date_trunc('week', now() at time zone 'America/Chicago'))::date;

  insert into public.fin_log_history (week_of, action, payload)
  values (wk, p_action, clean)
  returning id into new_id;

  return jsonb_build_object(
    'id', new_id,
    'action', p_action,
    'email_sent', false
  );
end;
$$;

revoke all on function public.fin_portal_read() from public;
revoke all on function public.fin_portal_append(text, jsonb) from public;
grant execute on function public.fin_portal_read() to anon, authenticated, service_role;
grant execute on function public.fin_portal_append(text, jsonb) to anon, authenticated, service_role;
