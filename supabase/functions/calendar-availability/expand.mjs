// Expand a Google Calendar ICS feed into per-day events.
// Titles are truncated. Descriptions, locations, and attendees are dropped.

function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function isoFromTime(time) {
  const month = String(time.month).padStart(2, '0');
  const day = String(time.day).padStart(2, '0');
  return `${time.year}-${month}-${day}`;
}

function minutesFromTime(time) {
  return time.hour * 60 + (Number(time.minute) || 0);
}

export async function loadICAL() {
  try {
    const mod = await import('ical.js');
    return mod.default || mod;
  } catch {
    const mod = await import('npm:ical.js@2.1.0');
    return mod.default || mod;
  }
}

export async function expandCalendar(icsText, { dates, timezone }) {
  const ICAL = await loadICAL();
  if (ICAL.TimezoneService.reset) ICAL.TimezoneService.reset();
  const comp = new ICAL.Component(ICAL.parse(String(icsText || '')));
  for (const zone of comp.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(zone);
  }
  const target = timezone ? ICAL.TimezoneService.get(timezone) : null;
  const timezoneApplied = Boolean(target);
  const wanted = new Set(dates);
  const days = {};
  for (const date of dates) days[date] = [];
  const sorted = [...dates].sort();
  const rangeStart = sorted[0];
  const rangeEnd = addDays(sorted[sorted.length - 1], 1);

  function project(time) {
    if (!time) return null;
    if (time.isDate || !target) return time;
    const tzid = time.zone && time.zone.tzid;
    if (!tzid || tzid === timezone) return time;
    try {
      return time.convertToZone(target);
    } catch {
      return time;
    }
  }

  function pushEvent(date, event) {
    if (!wanted.has(date) || days[date].length >= 100) return;
    days[date].push(event);
  }

  function emit(startRaw, endRaw, meta) {
    const start = project(startRaw);
    const end = project(endRaw || startRaw);
    if (!start) return;
    if (start.isDate) {
      let cursor = isoFromTime(start);
      const endIso = end && end.isDate ? isoFromTime(end) : addDays(cursor, 1);
      let guard = 0;
      while (cursor < endIso && guard < 21) {
        pushEvent(cursor, {
          start: 0,
          end: 1440,
          title: meta.title,
          allDay: true,
          transparent: meta.transparent,
        });
        cursor = addDays(cursor, 1);
        guard += 1;
      }
      return;
    }
    let cursorDate = isoFromTime(start);
    let cursorMin = minutesFromTime(start);
    const endDate = isoFromTime(end);
    const endMin = minutesFromTime(end);
    let guard = 0;
    while (guard < 4) {
      const isLast = cursorDate === endDate;
      const sliceEnd = isLast ? endMin : 1440;
      if (sliceEnd > cursorMin) {
        pushEvent(cursorDate, {
          start: cursorMin,
          end: sliceEnd,
          title: meta.title,
          allDay: false,
          transparent: meta.transparent,
        });
      }
      if (isLast || sliceEnd === endMin) break;
      cursorDate = addDays(cursorDate, 1);
      cursorMin = 0;
      guard += 1;
    }
  }

  for (const vevent of comp.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(vevent);
    const status = String(vevent.getFirstPropertyValue('status') || '').toUpperCase();
    if (status === 'CANCELLED') continue;
    if (!event.startDate) continue;
    const transparent = String(vevent.getFirstPropertyValue('transp') || 'OPAQUE').toUpperCase() === 'TRANSPARENT';
    const title = String(event.summary || 'Busy').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Busy';
    const meta = { title, transparent };

    if (event.isRecurring()) {
      const iterator = event.iterator();
      let guard = 0;
      let previous = '';
      let next;
      while ((next = iterator.next()) && guard < 20000) {
        guard += 1;
        const key = next.toString();
        if (key === previous) break;
        previous = key;
        const details = event.getOccurrenceDetails(next);
        const start = details.startDate;
        const end = details.endDate || start;
        const startIso = isoFromTime(project(start));
        if (startIso >= rangeEnd) break;
        const endIso = isoFromTime(project(end));
        if (endIso < rangeStart) continue;
        emit(start, end, meta);
      }
      continue;
    }

    emit(event.startDate, event.endDate || event.startDate, meta);
  }

  return { days, timezoneApplied };
}
