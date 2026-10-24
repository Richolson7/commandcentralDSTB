import test from 'node:test';
import assert from 'node:assert/strict';
import { expandCalendar } from '../supabase/functions/calendar-availability/expand.mjs';

const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:America/Chicago
X-LIC-LOCATION:America/Chicago
BEGIN:DAYLIGHT
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:gym
DTSTART;TZID=America/Chicago:20180105T060000
DTEND;TZID=America/Chicago:20180105T070000
RRULE:FREQ=WEEKLY;BYDAY=FR
SUMMARY:Gym
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
UID:utc
DTSTART:20261023T150000Z
DTEND:20261023T160000Z
SUMMARY:UTC call
END:VEVENT
BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20261023
DTEND;VALUE=DATE:20261024
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
UID:lunch
DTSTART;TZID=America/Chicago:20261023T120000
DTEND;TZID=America/Chicago:20261023T124500
SUMMARY:Lunch
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:ny
DTSTART;TZID=America/New_York:20261023T090000
DTEND;TZID=America/New_York:20261023T100000
SUMMARY:NY standup
END:VEVENT
BEGIN:VEVENT
UID:late
DTSTART;TZID=America/Chicago:20261022T220000
DTEND;TZID=America/Chicago:20261023T013000
SUMMARY:Late night
END:VEVENT
BEGIN:VEVENT
UID:cancel
DTSTART;TZID=America/Chicago:20261023T080000
DTEND;TZID=America/Chicago:20261023T083000
SUMMARY:Cancelled thing
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;

test('expands recurring, all-day, transparent, overnight, and zoned events', async () => {
  const { days, timezoneApplied } = await expandCalendar(ics, {
    dates: ['2026-10-23', '2026-10-24'],
    timezone: 'America/Chicago',
  });
  assert.equal(timezoneApplied, true);
  const friday = days['2026-10-23'];
  const titles = friday.map(event => `${event.title}@${event.start}-${event.end}${event.allDay ? ':all' : ''}${event.transparent ? ':free' : ''}`);
  assert.ok(titles.includes('Gym@360-420'));
  assert.ok(titles.includes('UTC call@600-660'));
  assert.ok(titles.includes('Holiday@0-1440:all'));
  assert.ok(titles.includes('Lunch@720-765:free'));
  assert.ok(titles.includes('NY standup@480-540'));
  assert.ok(titles.includes('Late night@0-90'));
  assert.equal(titles.some(item => item.startsWith('Cancelled')), false);
  assert.equal(days['2026-10-24'].some(event => event.title === 'Gym'), false);
  assert.ok(days['2026-10-22'] == null);
});
