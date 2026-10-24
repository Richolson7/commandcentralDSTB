// Pure scheduling helpers for the Running tab. No DOM, no network.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseHHMM(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function toHHMM(mins) {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(mins)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatClock(mins) {
  let value = Math.round(mins);
  if (value === 24 * 60) return '12:00 AM';
  value = ((value % 1440) + 1440) % 1440;
  let hour = Math.floor(value / 60);
  const minute = value % 60;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function formatRange(start, end) {
  return `${formatClock(start)}–${formatClock(end)}`;
}

export function formatDuration(mins) {
  const value = Math.max(0, Math.round(Number(mins) || 0));
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  if (hour && minute) return `${hour}h ${minute}m`;
  if (hour) return `${hour}h`;
  return `${minute}m`;
}

export function clampEstimate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 30;
  return Math.min(720, Math.max(5, Math.round(number)));
}

export function weekdayOfIso(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function weekdayName(iso) {
  return WEEKDAYS[weekdayOfIso(iso)];
}

export function formatShortDate(iso) {
  const [, month, day] = String(iso).split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}

export function formatLongDate(iso) {
  return `${weekdayName(iso)}, ${formatShortDate(iso)}`;
}

export function addDays(iso, days) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function todayIso(timeZone, now = new Date()) {
  let zone = timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const bag = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${bag.year}-${bag.month}-${bag.day}`;
}

export function isWeekendIso(iso) {
  const weekday = weekdayOfIso(iso);
  return weekday === 0 || weekday === 6;
}

export function nextMonday(iso) {
  const weekday = weekdayOfIso(iso);
  if (weekday === 0) return addDays(iso, 1);
  if (weekday === 6) return addDays(iso, 2);
  return addDays(iso, (8 - weekday) % 7);
}

export function guessTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

export function defaultWorkWindows() {
  const windows = {};
  for (let day = 0; day < 7; day += 1) {
    windows[String(day)] = {
      enabled: day >= 1 && day <= 5,
      start: '06:00',
      end: '20:00',
    };
  }
  return windows;
}

export function defaultSettings(timeZone) {
  return {
    work_windows: defaultWorkWindows(),
    manual_blocks: [],
    focus_keywords: 'Focus, Work block, Tasks',
    min_gap_minutes: 15,
    ignore_all_day: true,
    ignore_transparent: true,
    timezone: timeZone || guessTimeZone(),
  };
}

function normalizeWindow(value) {
  const start = parseHHMM(value && value.start) != null ? value.start : '06:00';
  const end = parseHHMM(value && value.end) != null ? value.end : '20:00';
  return {
    enabled: !!(value && value.enabled),
    start: String(start).slice(0, 5),
    end: String(end).slice(0, 5),
  };
}

export function normalizeSettings(raw, timeZone) {
  const base = defaultSettings(timeZone);
  if (!raw || typeof raw !== 'object') return base;
  const work = { ...base.work_windows };
  const incoming = raw.work_windows && typeof raw.work_windows === 'object' ? raw.work_windows : {};
  for (let day = 0; day < 7; day += 1) {
    work[String(day)] = normalizeWindow(incoming[String(day)] || incoming[day] || work[String(day)]);
  }
  const blocks = Array.isArray(raw.manual_blocks) ? raw.manual_blocks : [];
  return {
    work_windows: work,
    manual_blocks: blocks
      .map(block => ({
        weekday: Number(block.weekday),
        start: block.start,
        end: block.end,
      }))
      .filter(block => block.weekday >= 0 && block.weekday <= 6 && parseHHMM(block.start) != null && parseHHMM(block.end) != null && parseHHMM(block.end) > parseHHMM(block.start)),
    focus_keywords: typeof raw.focus_keywords === 'string' ? raw.focus_keywords : base.focus_keywords,
    min_gap_minutes: Math.min(240, Math.max(0, Number(raw.min_gap_minutes ?? base.min_gap_minutes) || 0)),
    ignore_all_day: raw.ignore_all_day !== false,
    ignore_transparent: raw.ignore_transparent !== false,
    timezone: typeof raw.timezone === 'string' && raw.timezone.trim() ? raw.timezone.trim() : base.timezone,
  };
}

export function mergeIntervals(list) {
  const sorted = (list || [])
    .filter(item => item && item.end > item.start)
    .map(item => ({ ...item }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (!last || item.start > last.end) {
      merged.push({ ...item });
      continue;
    }
    last.end = Math.max(last.end, item.end);
    if (item.title && last.title && !last.title.split(' · ').includes(item.title)) {
      last.title = `${last.title} · ${item.title}`;
    } else if (item.title && !last.title) {
      last.title = item.title;
    }
  }
  return merged;
}

function subtractRange(start, end, busy) {
  let cursor = start;
  const free = [];
  for (const block of busy) {
    if (block.end <= cursor) continue;
    if (block.start >= end) break;
    const blockStart = Math.max(block.start, cursor);
    if (blockStart > cursor) free.push({ start: cursor, end: Math.min(blockStart, end) });
    cursor = Math.max(cursor, Math.min(block.end, end));
  }
  if (cursor < end) free.push({ start: cursor, end });
  return free.filter(item => item.end > item.start);
}

function keywordList(settings) {
  return String(settings.focus_keywords || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isFocusTitle(title, settings) {
  const haystack = String(title || '').toLowerCase();
  return keywordList(settings).some(keyword => haystack.includes(keyword));
}

export function freeWindows({ dateIso, events, settings }) {
  const settingsNorm = normalizeSettings(settings);
  const weekday = String(weekdayOfIso(dateIso));
  const window = settingsNorm.work_windows[weekday];
  if (!window || !window.enabled) return { free: [], busy: [] };
  const dayStart = parseHHMM(window.start);
  const dayEnd = parseHHMM(window.end);
  if (dayStart == null || dayEnd == null || dayEnd <= dayStart) return { free: [], busy: [] };

  const busy = [];
  for (const event of events || []) {
    if (event.date && event.date !== dateIso) continue;
    const title = event.title || 'Busy';
    if (isFocusTitle(title, settingsNorm)) continue;
    if (event.allDay) {
      if (settingsNorm.ignore_all_day) continue;
      busy.push({ start: dayStart, end: dayEnd, title });
      continue;
    }
    if (event.transparent && settingsNorm.ignore_transparent) continue;
    const start = Math.max(dayStart, Number(event.start));
    const end = Math.min(dayEnd, Number(event.end));
    if (end > start) busy.push({ start, end, title });
  }
  const merged = mergeIntervals(busy);
  const minGap = settingsNorm.min_gap_minutes;
  const free = subtractRange(dayStart, dayEnd, merged).filter(gap => gap.end - gap.start >= minGap);
  return { free, busy: merged };
}

export function manualWindows(dateIso, settings) {
  const settingsNorm = normalizeSettings(settings);
  const weekday = weekdayOfIso(dateIso);
  const blocks = settingsNorm.manual_blocks
    .filter(block => block.weekday === weekday)
    .map(block => ({ start: parseHHMM(block.start), end: parseHHMM(block.end) }));
  return { free: mergeIntervals(blocks), busy: [] };
}

export function isRevenueTask(task) {
  return !!task && task.category === 'work' && (task.business === 'driven' || task.revenue === true);
}

export function isOnDay(task, todayIsoValue, dateIso) {
  if (!task || task.status === 'done' || !task.due_date) return false;
  if (task.due_date === dateIso) return true;
  return dateIso === todayIsoValue && task.due_date < todayIsoValue;
}

export function partitionToday({ tasks, todayIso: today }) {
  const pool = (tasks || []).filter(task => isOnDay(task, today, today));
  if (!isWeekendIso(today)) {
    return { staying: pool, movedToMonday: [], mondayIso: nextMonday(today) };
  }
  const staying = [];
  const movedToMonday = [];
  for (const task of pool) {
    const keep = task.category === 'personal' || task.weekend_scheduled || !isRevenueTask(task);
    if (keep) staying.push(task);
    else movedToMonday.push(task);
  }
  return { staying, movedToMonday, mondayIso: nextMonday(today) };
}

export function effectivePlanDate(task, today) {
  if (!task || task.status === 'done' || !task.due_date) return null;
  if (isWeekendIso(today) && isOnDay(task, today, today)) {
    const part = partitionToday({ tasks: [task], todayIso: today });
    if (part.movedToMonday.length) return part.mondayIso;
  }
  return task.due_date;
}

export function mondayPlanTasks({ tasks, todayIso: today }) {
  const mondayIso = nextMonday(today);
  const dueMonday = (tasks || []).filter(task => task && task.status !== 'done' && task.due_date === mondayIso);
  const pushed = isWeekendIso(today) ? partitionToday({ tasks, todayIso: today }).movedToMonday : [];
  const map = new Map();
  for (const task of [...dueMonday, ...pushed]) map.set(task.id, task);
  return { mondayIso, tasks: [...map.values()] };
}

function autoRank(a, b, today) {
  const aOver = a.due_date < today ? 0 : 1;
  const bOver = b.due_date < today ? 0 : 1;
  if (aOver !== bOver) return aOver - bOver;
  if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  const aPriority = Number(a.priority) || 2;
  const bPriority = Number(b.priority) || 2;
  if (aPriority !== bPriority) return aPriority - bPriority;
  const aSort = Number(a.sort_order) || 0;
  const bSort = Number(b.sort_order) || 0;
  if (aSort !== bSort) return aSort - bSort;
  return String(a.created_at || a.id || '').localeCompare(String(b.created_at || b.id || ''));
}

export function packDay({ todayIso: today, dateIso, tasks, windows }) {
  const onDay = (tasks || []).filter(task => isOnDay(task, today, dateIso));
  const open = (windows || []).map(window => ({
    start: window.start,
    end: window.end,
    items: [],
    remaining: window.end - window.start,
  }));
  const overflow = [];
  const auto = [];
  const pinned = new Map();

  for (const task of onDay) {
    if (task.placement === 'overflow' && task.pin_date === dateIso) {
      overflow.push(task);
      continue;
    }
    if (task.placement === 'window' && task.pin_date === dateIso) {
      const match = open.find(window => window.start === Number(task.pin_start_minute));
      if (!match) {
        auto.push(task);
        continue;
      }
      if (!pinned.has(match.start)) pinned.set(match.start, []);
      pinned.get(match.start).push(task);
      continue;
    }
    auto.push(task);
  }

  for (const window of open) {
    const items = (pinned.get(window.start) || []).sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    for (const task of items) {
      const estimate = clampEstimate(task.estimate_minutes);
      if (estimate <= window.remaining) {
        window.items.push(task);
        window.remaining -= estimate;
      } else {
        overflow.push(task);
      }
    }
  }

  auto.sort((a, b) => autoRank(a, b, today));
  for (const task of auto) {
    const estimate = clampEstimate(task.estimate_minutes);
    const window = open.find(item => item.remaining >= estimate);
    if (!window) {
      overflow.push(task);
      continue;
    }
    window.items.push(task);
    window.remaining -= estimate;
  }

  const planned = onDay.reduce((sum, task) => sum + clampEstimate(task.estimate_minutes), 0);
  const available = open.reduce((sum, window) => sum + (window.end - window.start), 0);
  const overBy = Math.max(0, planned - available);
  return {
    windows: open,
    overflow,
    planned,
    available,
    overBy,
    over: overBy > 0,
    suggestions: suggestMoves(onDay, overflow, overBy),
  };
}

export function suggestMoves(tasks, overflow, overBy) {
  if (!overBy || overBy <= 0) return [];
  const overflowIds = new Set((overflow || []).map(task => task.id));
  const ranked = [...(tasks || [])].sort((a, b) => {
    const aOverflow = overflowIds.has(a.id) ? 0 : 1;
    const bOverflow = overflowIds.has(b.id) ? 0 : 1;
    if (aOverflow !== bOverflow) return aOverflow - bOverflow;
    const priority = (Number(b.priority) || 2) - (Number(a.priority) || 2);
    if (priority) return priority;
    if (a.due_date !== b.due_date) return a.due_date < b.due_date ? 1 : -1;
    return clampEstimate(b.estimate_minutes) - clampEstimate(a.estimate_minutes);
  });
  const picked = [];
  let freed = 0;
  for (const task of ranked) {
    if (freed >= overBy) break;
    picked.push(task);
    freed += clampEstimate(task.estimate_minutes);
  }
  return picked;
}

export function assessCapacity({ todayIso: today, dateIso, tasks, windows, extraMinutes = 0, ignoreId = null }) {
  const relevant = (tasks || []).filter(task => task.id !== ignoreId && isOnDay(task, today, dateIso));
  const planned = relevant.reduce((sum, task) => sum + clampEstimate(task.estimate_minutes), 0) + Math.max(0, Number(extraMinutes) || 0);
  const available = (windows || []).reduce((sum, window) => sum + Math.max(0, window.end - window.start), 0);
  const overBy = Math.max(0, planned - available);
  return { planned, available, overBy, over: overBy > 0 };
}

export function previewCalendarEvents(dateIso) {
  return [
    { date: dateIso, start: 6 * 60, end: 7 * 60, title: 'Gym', allDay: false, transparent: false },
    { date: dateIso, start: 9 * 60, end: 10 * 60, title: 'Team meeting', allDay: false, transparent: false },
    { date: dateIso, start: 10 * 60 + 30, end: 12 * 60, title: 'Client visit', allDay: false, transparent: false },
    { date: dateIso, start: 12 * 60, end: 12 * 60 + 45, title: 'Lunch', allDay: false, transparent: true },
    { date: dateIso, start: 13 * 60, end: 15 * 60, title: 'Focus block', allDay: false, transparent: false },
    { date: dateIso, start: 15 * 60, end: 15 * 60 + 45, title: 'School pickup', allDay: false, transparent: false },
    { date: dateIso, start: 18 * 60, end: 19 * 60 + 30, title: 'Dinner', allDay: false, transparent: false },
    { date: dateIso, start: 0, end: 1440, title: 'Company holiday', allDay: true, transparent: false },
  ];
}
