-- Shared finance office for Driven and Trailblazers.
-- Adds one nullable jsonb column and one new dashboard_data row.
-- Does not change existing rows, week_data, policies, or scorecard metrics.

alter table public.dashboard_data
  add column if not exists finance_office jsonb;

insert into public.dashboard_data (id, finance_office)
values (
  'finance_shared',
  $fin$
{
  "team": [
    {"role": "Owner", "name": "Rich", "detail": ""},
    {"role": "CFO", "name": "TBD", "detail": ""},
    {"role": "Bookkeeper", "name": "TBD", "detail": "Uses QuickBooks Online"},
    {"role": "Accountant", "name": "TBD", "detail": "Hired to clean up the books"}
  ],
  "meetings": [
    {
      "id": "weekly-rich-cfo",
      "cadence": "Weekly",
      "attendees": "Rich + CFO",
      "purpose": "Cash position, A/R and A/P, open items in the books, decisions needed.",
      "agenda": "Cash position\nA/R and A/P\nOpen items in the books\nDecisions needed",
      "next_date": "",
      "not_l10": false
    },
    {
      "id": "weekly-rich-bookkeeper",
      "cadence": "Weekly",
      "attendees": "Rich + Bookkeeper",
      "purpose": "Reconciliation status, bills to approve, missing documents, questions.",
      "agenda": "Reconciliation status\nBills to approve\nMissing documents\nQuestions",
      "next_date": "",
      "not_l10": false
    },
    {
      "id": "monthly-cfo-bookkeeper",
      "cadence": "Monthly",
      "attendees": "CFO + Bookkeeper",
      "purpose": "Month-end close, reconciliations, tie-outs, review of the cleanup list with the accountant.",
      "agenda": "Month-end close\nReconciliations\nTie-outs\nReview of the cleanup list with the accountant",
      "next_date": "",
      "not_l10": false
    },
    {
      "id": "quarterly-business-review",
      "cadence": "Quarterly",
      "attendees": "Not named yet",
      "purpose": "High-level business review. P&L and margin trends by company, cash and debt, strategy, hiring/comp (e.g. sales rep comp), annual goals.",
      "agenda": "P&L and margin trends by company\nCash and debt\nStrategy\nHiring/comp (e.g. sales rep comp)\nAnnual goals",
      "next_date": "",
      "not_l10": true
    }
  ],
  "cleanup": [
    {
      "id": "both-books-not-reconciled",
      "company": "both",
      "description": "Books not reconciled on time; tie-outs run late.",
      "owner": "TBD",
      "date_found": "",
      "date_fixed": "",
      "notes": "",
      "status": "open"
    },
    {
      "id": "both-gl-balance-sheet",
      "company": "both",
      "description": "General ledger and balance sheet are wrong / numbers inaccurate.",
      "owner": "TBD",
      "date_found": "",
      "date_fixed": "",
      "notes": "",
      "status": "open"
    },
    {
      "id": "tb-ar-mismatch",
      "company": "trailblazers",
      "description": "A/R mismatch — about $9.9K in QuickBooks vs about $20.3K in Jobber; needs reconciling.",
      "owner": "TBD",
      "date_found": "",
      "date_fixed": "",
      "notes": "",
      "status": "open"
    },
    {
      "id": "both-bookkeeping-routines",
      "company": "both",
      "description": "Bookkeeping routines (moving money between accounts, paying bills) need a defined process — owner prepares, nothing paid or moved without Rich's approval.",
      "owner": "TBD",
      "date_found": "",
      "date_fixed": "",
      "notes": "",
      "status": "open"
    }
  ]
}
$fin$::jsonb
)
on conflict (id) do nothing;
