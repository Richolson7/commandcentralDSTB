// Read-only Google Calendar availability for the Command Center Running tab.
//
// Secrets (set in Supabase, never in this repo or the browser):
//   CALENDAR_ICS_URL        Google Calendar secret iCal address
//   CALENDAR_OWNER_EMAILS   Comma-separated allowlist, e.g. rich@example.com
//
// The function returns start/end/title only. It never creates or edits events.
// verify_jwt is on, and the email allowlist is checked again here.

import { createClient } from '@supabase/supabase-js';
import { expandCalendar } from './expand.mjs';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function ownerEmails() {
  return String(Deno.env.get('CALENDAR_OWNER_EMAILS') || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function calendarUrl() {
  const raw = String(Deno.env.get('CALENDAR_ICS_URL') || '').trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('bad protocol');
  const host = url.hostname.toLowerCase();
  if (host !== 'calendar.google.com') throw new Error('bad host');
  return url.toString();
}

function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

async function caller(req: Request) {
  const header = req.headers.get('Authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    { global: { headers: { Authorization: header } } },
  );
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ configured: false, reason: 'method' }, 405);

  try {
    const user = await caller(req);
    if (!user || !user.email) return json({ configured: false, reason: 'unauthorized' }, 401);

    const owners = ownerEmails();
    let ics: string | null = null;
    try {
      ics = calendarUrl();
    } catch {
      return json({ configured: false, reason: 'not_configured' });
    }
    if (!ics || owners.length === 0) return json({ configured: false, reason: 'not_configured' });
    if (!owners.includes(user.email.toLowerCase())) return json({ configured: false, reason: 'forbidden' }, 403);
    if (!user.email_confirmed_at && !user.confirmed_at) {
      return json({ configured: false, reason: 'forbidden' }, 403);
    }

    const body = await req.json().catch(() => null) as { dates?: unknown; timezone?: unknown } | null;
    const dates = Array.isArray(body?.dates) ? body.dates.map(item => String(item)) : [];
    const timezone = String(body?.timezone || '');
    if (dates.length < 1 || dates.length > 16 || dates.some(date => !DATE_RE.test(date))) {
      return json({ configured: false, reason: 'bad_request' }, 400);
    }
    if (!validTimeZone(timezone)) return json({ configured: false, reason: 'bad_request' }, 400);

    const response = await fetch(ics, {
      headers: { 'User-Agent': 'command-center-calendar' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return json({ configured: true, reason: 'fetch_failed', days: {} }, 200);
    const text = await response.text();
    if (text.length > 8_000_000) return json({ configured: true, reason: 'fetch_failed', days: {} }, 200);

    const expanded = await expandCalendar(text, { dates, timezone });
    return json({
      configured: true,
      fetchedAt: new Date().toISOString(),
      timezone,
      timezoneApplied: expanded.timezoneApplied,
      days: expanded.days,
    });
  } catch {
    return json({ configured: false, reason: 'unavailable' }, 500);
  }
});
