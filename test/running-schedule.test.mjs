import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  assessCapacity,
  defaultSettings,
  formatDuration,
  freeWindows,
  isWeekendIso,
  manualWindows,
  mondayPlanTasks,
  nextMonday,
  packDay,
  partitionToday,
  previewCalendarEvents,
  weekdayOfIso,
} from '../js/running-schedule.js';

const friday = '2026-10-23';
const saturday = '2026-10-24';
const sunday = '2026-10-25';

test('seed weekend date is Sunday and Monday follows the weekend', () => {
  assert.equal(weekdayOfIso(friday), 5);
  assert.equal(weekdayOfIso(saturday), 6);
  assert.equal(weekdayOfIso(sunday), 0);
  assert.equal(isWeekendIso(sunday), true);
  assert.equal(nextMonday(saturday), '2026-10-26');
  assert.equal(nextMonday(sunday), '2026-10-26');
  assert.equal(addDays(sunday, 1), '2026-10-26');
});

test('calendar free windows ignore focus titles, all-day events, transparent events, and short gaps', () => {
  const settings = defaultSettings('America/Chicago');
  settings.work_windows['5'] = { enabled: true, start: '06:00', end: '20:00' };
  const events = [
    ...previewCalendarEvents(friday),
    { date: friday, start: 16 * 60, end: 16 * 60 + 10, title: 'Tiny gap filler', allDay: false, transparent: false },
    { date: friday, start: 16 * 60 + 10, end: 16 * 60 + 20, title: 'Another sliver', allDay: false, transparent: false },
  ];
  const { free, busy } = freeWindows({ dateIso: friday, events, settings });
  assert.deepEqual(busy.map(item => item.title), ['Gym', 'Team meeting', 'Client visit', 'School pickup', 'Tiny gap filler · Another sliver', 'Dinner']);
  assert.ok(free.some(item => item.start === 7 * 60 && item.end === 9 * 60));
  assert.ok(free.some(item => item.start <= 13 * 60 && item.end >= 15 * 60), 'Focus block stays available');
  assert.equal(free.some(item => item.end - item.start < 15), false);
});

test('disabled weekend work window yields no calendar free time', () => {
  const settings = defaultSettings('America/Chicago');
  const result = freeWindows({ dateIso: sunday, events: previewCalendarEvents(sunday), settings });
  assert.deepEqual(result.free, []);
});

test('manual blocks are the fallback windows and overlapping blocks merge', () => {
  const settings = defaultSettings('America/Chicago');
  settings.manual_blocks = [
    { weekday: 5, start: '07:00', end: '09:00' },
    { weekday: 5, start: '08:30', end: '10:00' },
    { weekday: 5, start: '13:00', end: '15:30' },
  ];
  const { free } = manualWindows(friday, settings);
  assert.deepEqual(free, [
    { start: 7 * 60, end: 10 * 60 },
    { start: 13 * 60, end: 15 * 60 + 30 },
  ]);
});

test('packs overdue first and leaves what does not fit', () => {
  const windows = [{ start: 7 * 60, end: 7 * 60 + 30 }];
  const tasks = [
    { id: 'later', due_date: friday, status: 'todo', estimate_minutes: 30, priority: 1, sort_order: 0 },
    { id: 'overdue', due_date: '2026-10-20', status: 'todo', estimate_minutes: 30, priority: 3, sort_order: 5 },
    { id: 'done', due_date: friday, status: 'done', estimate_minutes: 30, priority: 1, sort_order: 0 },
    { id: 'undated', due_date: null, status: 'todo', estimate_minutes: 30, priority: 1, sort_order: 0 },
  ];
  const packed = packDay({ todayIso: friday, dateIso: friday, tasks, windows });
  assert.deepEqual(packed.windows[0].items.map(task => task.id), ['overdue']);
  assert.deepEqual(packed.overflow.map(task => task.id), ['later']);
  assert.equal(packed.planned, 60);
  assert.equal(packed.available, 30);
  assert.equal(packed.over, true);
});

test('priority and manual order break ties after the due date', () => {
  const windows = [{ start: 9 * 60, end: 10 * 60 }];
  const tasks = [
    { id: 'low', due_date: friday, status: 'todo', estimate_minutes: 30, priority: 3, sort_order: 0 },
    { id: 'high-late', due_date: friday, status: 'todo', estimate_minutes: 30, priority: 1, sort_order: 2 },
    { id: 'high-early', due_date: friday, status: 'todo', estimate_minutes: 30, priority: 1, sort_order: 1 },
  ];
  const packed = packDay({ todayIso: friday, dateIso: friday, tasks, windows });
  assert.deepEqual(packed.windows[0].items.map(task => task.id), ['high-early', 'high-late']);
  assert.deepEqual(packed.overflow.map(task => task.id), ['low']);
});

test('pinned tasks stay in their block and a too-long pin overflows', () => {
  const windows = [
    { start: 7 * 60, end: 8 * 60 },
    { start: 13 * 60, end: 15 * 60 },
  ];
  const tasks = [
    { id: 'pinned', due_date: friday, status: 'todo', estimate_minutes: 90, priority: 1, sort_order: 0, placement: 'window', pin_date: friday, pin_start_minute: 13 * 60 },
    { id: 'auto', due_date: friday, status: 'todo', estimate_minutes: 30, priority: 2, sort_order: 0, placement: 'auto' },
  ];
  const packed = packDay({ todayIso: friday, dateIso: friday, tasks, windows });
  assert.deepEqual(packed.windows[0].items.map(task => task.id), ['auto']);
  assert.deepEqual(packed.windows[1].items.map(task => task.id), ['pinned']);
});

test('overload suggestions prefer overflow, then lowest priority and latest due', () => {
  const windows = [{ start: 7 * 60, end: 8 * 60 }];
  const tasks = [
    { id: 'high', due_date: friday, status: 'todo', estimate_minutes: 30, priority: 1, sort_order: 0 },
    { id: 'low-early', due_date: '2026-10-22', status: 'todo', estimate_minutes: 30, priority: 3, sort_order: 0 },
    { id: 'low-late', due_date: friday, status: 'todo', estimate_minutes: 45, priority: 3, sort_order: 0 },
  ];
  const packed = packDay({ todayIso: friday, dateIso: friday, tasks, windows });
  assert.equal(formatDuration(packed.planned), '1h 45m');
  assert.equal(formatDuration(packed.available), '1h');
  assert.equal(formatDuration(packed.overBy), '45m');
  assert.deepEqual(packed.suggestions.map(task => task.id), ['low-late']);
});

test('weekend display push keeps personal and explicit weekend tasks, and holds revenue work for Monday', () => {
  const tasks = [
    { id: 'finance', title: 'Finance department', category: 'work', business: null, weekend_scheduled: true, revenue: false, due_date: sunday, status: 'todo', estimate_minutes: 180 },
    { id: 'ground', title: 'Get email for The Ground Up', category: 'work', business: 'ground_up', weekend_scheduled: true, revenue: false, due_date: sunday, status: 'todo', estimate_minutes: 60 },
    { id: 'other', title: 'Other weekend tasks', category: 'work', business: null, weekend_scheduled: true, revenue: false, due_date: sunday, status: 'todo', estimate_minutes: 60 },
    { id: 'driven', category: 'work', business: 'driven', weekend_scheduled: false, revenue: false, due_date: sunday, status: 'todo', estimate_minutes: 120 },
    { id: 'driven-keep', category: 'work', business: 'driven', weekend_scheduled: true, revenue: false, due_date: sunday, status: 'todo', estimate_minutes: 30 },
    { id: 'life', category: 'personal', business: null, weekend_scheduled: false, revenue: false, due_date: sunday, status: 'todo', estimate_minutes: 45 },
    { id: 'tb-revenue', category: 'work', business: 'trailblazers', weekend_scheduled: false, revenue: true, due_date: '2026-10-20', status: 'todo', estimate_minutes: 30 },
    { id: 'tb-normal', category: 'work', business: 'trailblazers', weekend_scheduled: false, revenue: false, due_date: sunday, status: 'todo', estimate_minutes: 30 },
  ];
  const part = partitionToday({ tasks, todayIso: sunday });
  assert.deepEqual(part.staying.map(task => task.id).sort(), ['driven-keep', 'finance', 'ground', 'life', 'other', 'tb-normal']);
  assert.deepEqual(part.movedToMonday.map(task => task.id).sort(), ['driven', 'tb-revenue']);
  assert.equal(part.mondayIso, '2026-10-26');

  const windows = [{ start: 9 * 60, end: 12 * 60 }];
  const packed = packDay({ todayIso: sunday, dateIso: sunday, tasks: part.staying, windows });
  assert.equal(packed.planned, 180 + 60 + 60 + 30 + 45 + 30);
  assert.equal(packed.planned, 405);
  assert.ok(!packed.windows.some(window => window.items.some(task => task.id === 'driven')));

  const monday = mondayPlanTasks({ tasks, todayIso: sunday });
  assert.equal(monday.mondayIso, '2026-10-26');
  assert.ok(monday.tasks.some(task => task.id === 'driven'));
  assert.ok(monday.tasks.some(task => task.id === 'tb-revenue'));
  assert.ok(!monday.tasks.some(task => task.id === 'finance'));
});

test('capacity check warns when a new task overbooks the day it lands on', () => {
  const tasks = [
    { id: 'a', due_date: friday, status: 'todo', estimate_minutes: 60, priority: 2 },
  ];
  const windows = [{ start: 7 * 60, end: 8 * 60 }];
  const full = assessCapacity({ todayIso: friday, dateIso: friday, tasks, windows, extraMinutes: 30 });
  assert.equal(full.over, true);
  assert.equal(full.overBy, 30);
  const ignored = assessCapacity({ todayIso: friday, dateIso: friday, tasks, windows, extraMinutes: 30, ignoreId: 'a' });
  assert.equal(ignored.over, false);
});
