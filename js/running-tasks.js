import {
  addDays,
  assessCapacity,
  clampEstimate,
  defaultSettings,
  effectivePlanDate,
  formatDuration,
  formatLongDate,
  formatRange,
  formatShortDate,
  freeWindows,
  guessTimeZone,
  isOnDay,
  isRevenueTask,
  isWeekendIso,
  manualWindows,
  mondayPlanTasks,
  nextMonday,
  normalizeSettings,
  packDay,
  partitionToday,
  previewCalendarEvents,
  weekdayName,
} from './running-schedule.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUSES = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'done', label: 'Done' },
];
const BUSINESSES = [
  { id: 'driven', label: 'Driven' },
  { id: 'trailblazers', label: 'Trailblazers' },
  { id: 'ground_up', label: 'The Ground Up' },
];

const state = {
  session: null,
  tasks: [],
  settings: null,
  view: 'today',
  biz: 'all',
  calendar: { status: 'manual', fetchedAt: null, days: {}, timezoneApplied: true, reason: 'not_configured' },
  modal: null,
  hoursOpen: false,
  blockDraft: [],
  bootedFor: null,
  loadError: '',
  seedError: '',
  authMode: 'signin',
  authError: '',
  authBusy: false,
  dragging: false,
  suppressClick: false,
  channel: null,
  reloadTimer: null,
};

function db() {
  return window.db;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function toast(message, type) {
  if (typeof window.toast === 'function') window.toast(message, type);
}

function settings() {
  return state.settings || defaultSettings(guessTimeZone());
}

function params() {
  return new URLSearchParams(window.location.search);
}

function previewOn() {
  return params().get('rtPreview') === '1';
}

function realToday() {
  return settings().timezone ? isoToday(settings().timezone) : isoToday(guessTimeZone());
}

function isoToday(timeZone) {
  const now = new Date();
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const bag = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${bag.year}-${bag.month}-${bag.day}`;
}

function displayedToday() {
  const override = params().get('rtDay');
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return realToday();
}

function businessLabel(id) {
  return (BUSINESSES.find(item => item.id === id) || {}).label || 'Work';
}

function dueLabel(iso, today) {
  if (!iso) return '';
  if (iso === today) return 'Today';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  return formatShortDate(iso);
}

function windowsFor(dateIso) {
  const prefs = settings();
  if (previewOn() && dateIso === displayedToday()) {
    return { ...freeWindows({ dateIso, events: previewCalendarEvents(dateIso), settings: prefs }), source: 'preview' };
  }
  if (state.calendar.status === 'calendar' && Object.prototype.hasOwnProperty.call(state.calendar.days, dateIso)) {
    return { ...freeWindows({ dateIso, events: state.calendar.days[dateIso] || [], settings: prefs }), source: 'calendar' };
  }
  return { ...manualWindows(dateIso, prefs), source: 'manual' };
}

function statusLine() {
  if (state.calendar.status === 'preview') return 'Sample calendar — Gym, meetings, and Focus below are examples, not your Google Calendar.';
  if (state.calendar.status === 'loading') return 'Checking Google Calendar…';
  if (state.calendar.status === 'calendar') {
    const when = state.calendar.fetchedAt
      ? new Date(state.calendar.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';
    const zone = state.calendar.timezoneApplied ? '' : ' · times may not match the Hours timezone';
    return `Calendar connected${when ? ` · synced ${when}` : ''}${zone}`;
  }
  if (state.calendar.reason === 'forbidden') return 'This login cannot read the calendar · using manual blocks';
  if (state.calendar.reason === 'fetch_failed' || state.calendar.reason === 'unavailable') return 'Calendar did not load · using manual blocks';
  return 'Using manual blocks · calendar is not connected';
}

function matchesBusiness(task) {
  if (state.biz === 'all') return true;
  if (task.category !== 'work') return false;
  if (state.biz === 'untagged') return !task.business;
  return task.business === state.biz;
}

function visibleTasks() {
  return state.tasks.filter(task => {
    if (state.view === 'personal') return task.category === 'personal';
    if (state.view === 'work') return task.category === 'work' && matchesBusiness(task);
    if (state.view === 'all') return matchesBusiness(task);
    return true;
  });
}

function openCount(list) {
  return list.filter(task => task.status !== 'done').length;
}

function cardHtml(task, today, extra) {
  const overdue = task.status !== 'done' && task.due_date && task.due_date < today;
  const chips = [];
  if (task.category === 'personal') chips.push('<span class="rt-chip">Life OS</span>');
  else if (task.business) chips.push(`<span class="rt-chip">${esc(businessLabel(task.business))}</span>`);
  else chips.push('<span class="rt-chip">Work</span>');
  if (task.revenue && task.business !== 'driven') chips.push('<span class="rt-chip rt-chip-hot">Revenue</span>');
  if (task.weekend_scheduled) chips.push('<span class="rt-chip">Weekend</span>');
  if (Number(task.priority) === 1) chips.push('<span class="rt-chip rt-chip-hot">High</span>');
  if (Number(task.priority) === 3) chips.push('<span class="rt-chip">Low</span>');
  const due = task.due_date
    ? `<span class="rt-due${overdue ? ' rt-over' : ''}">${overdue ? 'Overdue · ' : ''}${esc(dueLabel(task.due_date, today))}</span>`
    : '';
  return `<article class="rt-card${task.status === 'done' ? ' rt-done' : ''}" data-task-id="${esc(task.id)}">
    <button type="button" class="rt-handle" data-drag-handle aria-label="Drag task">⋮⋮</button>
    <button type="button" class="rt-card-main" data-action="edit" data-id="${esc(task.id)}">
      <div class="rt-card-title">${esc(task.title)}</div>
      ${task.notes ? `<div class="rt-card-notes">${esc(task.notes)}</div>` : ''}
      <div class="rt-card-meta">${chips.join('')}${due}<span class="rt-est">${esc(formatDuration(clampEstimate(task.estimate_minutes)))}</span></div>
    </button>
    ${extra || ''}
  </article>`;
}

function actionRow(taskId, buttons) {
  return `<div class="rt-card-actions">${buttons.map(button => `<button type="button" class="tbtn" data-action="${button.action}" data-id="${esc(taskId)}">${esc(button.label)}</button>`).join('')}</div>`;
}

function renderAuth() {
  const signUp = state.authMode === 'signup';
  return `<div class="sec-title">Running</div>
    <div class="sec-sub">Your work and Life OS list. It is separate from the L10 Tasks tab. Opening it from Driven, Trailblazers, Life, or Ground Up starts on that area. Today, Work, Personal / Life OS, and All are still here.</div>
    <form class="rt-auth" id="rt-auth-form">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--g)">${signUp ? 'Create your login' : 'Sign in'}</div>
      <p class="rt-help">Tasks stay on your account. The public site key cannot read this list. Use email and a password so the list is there on your phone and computer.</p>
      <input id="rt-email" type="email" autocomplete="username" placeholder="Email" required>
      <input id="rt-password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" placeholder="Password (8+ characters)" minlength="8" required>
      ${state.authError ? `<div class="rt-error">${esc(state.authError)}</div>` : ''}
      <div class="rt-row">
        <button class="btn-g" type="submit" ${state.authBusy ? 'disabled' : ''}>${signUp ? 'Create account' : 'Sign in'}</button>
        <button class="tbtn" type="button" data-action="auth-mode">${signUp ? 'I already have a login' : 'Create an account'}</button>
      </div>
    </form>`;
}

function renderChrome() {
  const today = displayedToday();
  const part = partitionToday({ tasks: state.tasks, todayIso: today });
  const counts = {
    today: part.staying.length + part.movedToMonday.length,
    work: openCount(state.tasks.filter(task => task.category === 'work')),
    personal: openCount(state.tasks.filter(task => task.category === 'personal')),
    all: openCount(state.tasks),
  };
  const views = [
    ['today', `Today ${counts.today}`],
    ['work', `Work ${counts.work}`],
    ['personal', `Personal / Life OS ${counts.personal}`],
    ['all', `All tasks ${counts.all}`],
  ];
  return `<div class="rt-head">
      <div>
        <div class="sec-title">Running</div>
        <div class="sec-sub">Work for Driven, Trailblazers, and The Ground Up, plus Life OS. Separate from L10 Tasks. The area you opened sets the first filter. Today, Work, Personal / Life OS, and All still show the whole list.</div>
      </div>
      <div class="rt-row">
        <button type="button" class="tbtn" data-action="hours">Hours & calendar</button>
        <button type="button" class="tbtn" data-action="refresh-cal">Refresh calendar</button>
        <button type="button" class="btn-g" data-action="add">+ Task</button>
        <button type="button" class="tbtn" data-action="sign-out">Sign out</button>
      </div>
    </div>
    <div class="rt-views">${views.map(([id, label]) => `<button type="button" class="tbtn rt-view${state.view === id ? ' active' : ''}" data-action="view" data-view="${id}">${label}</button>`).join('')}</div>
    ${state.view === 'work' || state.view === 'all' ? `<div class="rt-biz">${[[ 'all', state.view === 'all' ? 'All' : 'All work' ], ['driven', 'Driven'], ['trailblazers', 'Trailblazers'], ['ground_up', 'The Ground Up'], ['untagged', 'Untagged']].map(([id, label]) => `<button type="button" class="tbtn${state.biz === id ? ' green' : ''}" data-action="biz" data-biz="${id}">${label}</button>`).join('')}</div>` : ''}
    <div class="rt-status"><span>${esc(statusLine())}</span></div>
    ${params().get('rtDay') ? `<div class="rt-banner">Date preview — showing ${esc(formatLongDate(today))}, not the real today. Remove <b>rtDay</b> from the address to go back.</div>` : ''}
    ${previewOn() ? '<div class="rt-banner">Sample calendar for layout only. These events are not from Google.</div>' : ''}
    ${state.seedError ? `<div class="rt-warn">${esc(state.seedError)}</div>` : ''}
    ${state.loadError ? `<div class="rt-warn">${esc(state.loadError)}</div>` : ''}`;
}

function renderMeter(packed, landingLabel) {
  const ratio = packed.available > 0 ? Math.min(100, Math.round((packed.planned / packed.available) * 100)) : (packed.planned > 0 ? 100 : 0);
  const suggestions = packed.over ? `<div class="rt-suggest"><div>Overbooked by ${esc(formatDuration(packed.overBy))}. Move the lowest-priority, latest-due items:</div>
      ${packed.suggestions.map(task => `<div class="rt-row"><span>${esc(task.title)} · ${esc(formatDuration(clampEstimate(task.estimate_minutes)))}</span>
        <button type="button" class="tbtn" data-action="push-tomorrow" data-id="${esc(task.id)}">Push to tomorrow</button></div>`).join('')}
    </div>` : '';
  return `<div class="rt-meter${packed.over ? ' over' : ''}">
    <div class="rt-meter-top"><div class="rt-meter-label">${esc(formatDuration(packed.planned))} planned of ${esc(formatDuration(packed.available))} available</div><div>${esc(landingLabel)}</div></div>
    <div class="rt-track"><div class="rt-fill" style="width:${ratio}%"></div></div>
    ${packed.over ? `<div style="margin-top:8px;color:var(--red)">This day is overbooked by ${esc(formatDuration(packed.overBy))}.</div>` : ''}
    ${suggestions}
  </div>`;
}

function renderToday() {
  const today = displayedToday();
  const part = partitionToday({ tasks: state.tasks, todayIso: today });
  const schedule = windowsFor(today);
  const packed = packDay({ todayIso: today, dateIso: today, tasks: part.staying, windows: schedule.free });
  const weekend = isWeekendIso(today);
  const banner = weekend
    ? `<div class="rt-light"><b>Light work day.</b> Revenue-producing Driven tasks wait until Monday unless you scheduled them for the weekend. Personal / Life OS tasks, and anything marked for the weekend, stay on today. Due dates do not change until you confirm.</div>`
    : '';
  const monday = mondayPlanTasks({ tasks: state.tasks, todayIso: today });
  const mondayMinutes = weekend ? monday.tasks.reduce((sum, task) => sum + clampEstimate(task.estimate_minutes), 0) : 0;
  const mondayNote = weekend && part.movedToMonday.length
    ? `<div class="rt-note">Monday ${esc(formatShortDate(monday.mondayIso))} already has ${esc(formatDuration(mondayMinutes))} planned, including work held from this weekend. That time is not in today's meter.</div>`
    : '';
  const rows = [
    ...schedule.busy.map(item => ({ kind: 'busy', ...item })),
    ...packed.windows.map(item => ({ kind: 'free', ...item })),
  ].sort((a, b) => a.start - b.start || (a.kind === 'busy' ? -1 : 1));
  const blocks = rows.length ? rows.map(row => {
    if (row.kind === 'busy') {
      return `<section class="rt-busy"><div class="rt-block-h">${esc(formatRange(row.start, row.end))} <span>Busy</span></div><div>${esc(row.title || 'Busy')}</div></section>`;
    }
    const cards = row.items.map(task => cardHtml(task, today)).join('') || '<div class="rt-empty">Drop a task here.</div>';
    return `<section class="rt-window" data-drop="window" data-drop-value="${row.start}">
      <div class="rt-block-h">${esc(formatRange(row.start, row.end))} <span>${esc(formatDuration(row.remaining))} open</span></div>
      ${cards}
    </section>`;
  }).join('') : '<div class="rt-note">No open hours for this day yet. Add manual blocks, or connect Google Calendar. Tasks still show under Doesn\'t fit today.</div>';
  const overflowCards = packed.overflow.map(task => cardHtml(task, today, actionRow(task.id, [
    { action: 'push-tomorrow', label: 'Tomorrow' },
    { action: 'pick-day', label: 'Another day' },
  ]))).join('') || '<div class="rt-empty">Tasks that do not fit in today\'s open hours land here.</div>';
  const moved = weekend ? `<section class="rt-monday" data-drop="monday" data-drop-value="1">
      <div class="rt-col-h">Moved to Monday <span>${part.movedToMonday.length}</span></div>
      <div class="rt-help" style="margin-bottom:8px">Display only. These are off today's meter and count on Monday. The stored due date stays until you confirm.</div>
      ${part.movedToMonday.map(task => cardHtml(task, today, actionRow(task.id, [
        { action: 'keep-weekend', label: 'Keep this weekend' },
        { action: 'commit-monday', label: 'Set due date to Monday' },
      ]))).join('') || '<div class="rt-empty">No revenue work is being held for Monday.</div>'}
    </section>` : '';
  return `${banner}${renderMeter(packed, formatLongDate(today))}${mondayNote}
    <div class="rt-day">${blocks}
      <section class="rt-overflow" data-drop="overflow" data-drop-value="1">
        <div class="rt-col-h">Doesn't fit today <span>${esc(formatDuration(packed.overflow.reduce((sum, task) => sum + clampEstimate(task.estimate_minutes), 0)))}</span></div>
        ${overflowCards}
      </section>
      ${moved}
    </div>`;
}

function renderBoard() {
  if (state.view === 'today') return renderToday();
  const today = displayedToday();
  const tasks = visibleTasks();
  return `<div class="rt-board">${STATUSES.map(status => {
    const items = tasks.filter(task => task.status === status.id).sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    return `<section class="rt-col" data-drop="status" data-drop-value="${status.id}">
      <div class="rt-col-h">${status.label} <span>${items.length}</span></div>
      ${items.map(task => cardHtml(task, today)).join('') || '<div class="rt-empty">Drop a task here.</div>'}
    </section>`;
  }).join('')}</div>`;
}

function renderMain() {
  const host = document.getElementById('rt-main');
  if (!host) return;
  if (!state.session) {
    host.innerHTML = renderAuth();
    return;
  }
  host.innerHTML = `${renderChrome()}<div id="rt-board">${renderBoard()}</div>`;
}

function loadWarning(draft) {
  if (!draft || draft.status === 'done' || !draft.due_date) return null;
  const today = displayedToday();
  const hypothetical = {
    ...draft,
    id: draft.id || '__draft__',
    category: draft.category === 'personal' ? 'personal' : 'work',
    business: draft.category === 'personal' ? null : (draft.business || null),
    estimate_minutes: clampEstimate(draft.estimate_minutes),
    weekend_scheduled: !!draft.weekend_scheduled,
    revenue: !!draft.revenue,
    status: draft.status || 'todo',
  };
  const others = state.tasks.filter(task => task.id !== draft.id);
  const landing = effectivePlanDate(hypothetical, today) || hypothetical.due_date;
  let pool;
  if (isWeekendIso(today) && landing === nextMonday(today)) pool = mondayPlanTasks({ tasks: [...others, hypothetical], todayIso: today }).tasks;
  else if (landing === today) pool = partitionToday({ tasks: [...others, hypothetical], todayIso: today }).staying;
  else pool = [...others, hypothetical].filter(task => task.status !== 'done' && task.due_date === landing);
  const windows = windowsFor(landing).free;
  const result = assessCapacity({
    todayIso: landing,
    dateIso: landing,
    tasks: pool.map(task => ({ ...task, due_date: task.due_date && task.due_date < landing ? task.due_date : landing })),
    windows,
  });
  return { ...result, landing };
}

function warningText(info) {
  if (!info) return '';
  if (info.available === 0 && info.planned > 0) {
    return `${formatLongDate(info.landing)} has no open hours. Saving puts this where it does not fit, and the day is overbooked by ${formatDuration(info.planned)}.`;
  }
  if (info.over) {
    return `${formatLongDate(info.landing)} would be ${formatDuration(info.planned)} planned of ${formatDuration(info.available)} — overbooked by ${formatDuration(info.overBy)}.`;
  }
  return '';
}

function renderModal() {
  const host = document.getElementById('rt-modal');
  if (!host) return;
  const draft = state.modal;
  if (!draft) {
    host.innerHTML = '';
    return;
  }
  const work = draft.category !== 'personal';
  const info = loadWarning(draft);
  const warn = warningText(info);
  host.innerHTML = `<div class="rt-modal-back"><div class="rt-modal" role="dialog" aria-modal="true">
    <div class="sec-title">${draft.id ? 'Edit task' : 'New task'}</div>
    <div class="rt-form">
      <label>Title <input id="rt-title" type="text" maxlength="300"></label>
      <label>Notes <textarea id="rt-notes" maxlength="8000"></textarea></label>
      <div class="rt-split">
        <label>Due date <input id="rt-due" type="date"></label>
        <label>Status <select id="rt-status">${STATUSES.map(item => `<option value="${item.id}">${item.label}</option>`).join('')}</select></label>
      </div>
      <div class="rt-split">
        <label>Category <select id="rt-category"><option value="work">Work</option><option value="personal">Personal / Life OS</option></select></label>
        <label>Priority <select id="rt-priority"><option value="1">High</option><option value="2">Normal</option><option value="3">Low</option></select></label>
      </div>
      ${work ? `<label>Business <select id="rt-business"><option value="">Untagged</option>${BUSINESSES.map(item => `<option value="${item.id}">${item.label}</option>`).join('')}</select></label>` : ''}
      <label>Estimate
        <input id="rt-estimate" type="number" min="5" max="720" step="5">
        <span class="rt-presets">${[15, 30, 45, 60, 90, 120, 180].map(minutes => `<button type="button" class="tbtn" data-action="preset" data-minutes="${minutes}">${formatDuration(minutes)}</button>`).join('')}</span>
      </label>
      ${work ? `<label class="rt-check"><input id="rt-revenue" type="checkbox"><span>Revenue-producing. Driven tasks are treated this way automatically. On Saturday and Sunday, revenue work is held for Monday unless you keep it on the weekend.</span></label>` : ''}
      <label class="rt-check"><input id="rt-weekend" type="checkbox"><span>Scheduled for the weekend. Keeps this task on Saturday or Sunday instead of holding it for Monday.</span></label>
      <div id="rt-warn" class="rt-warn" ${warn ? '' : 'hidden'}>${esc(warn)}</div>
      <div class="rt-row">
        <button type="button" class="btn-g" id="rt-save" data-action="save-task">${warn ? 'Save anyway' : 'Save'}</button>
        ${draft.id ? '<button type="button" class="tbtn red" data-action="delete-task">Delete</button>' : ''}
        <button type="button" class="tbtn" data-action="close-modal">Cancel</button>
      </div>
    </div>
  </div></div>`;
  document.getElementById('rt-title').value = draft.title || '';
  document.getElementById('rt-notes').value = draft.notes || '';
  document.getElementById('rt-due').value = draft.due_date || '';
  document.getElementById('rt-status').value = draft.status || 'todo';
  document.getElementById('rt-category').value = work ? 'work' : 'personal';
  document.getElementById('rt-priority').value = String(draft.priority || 2);
  document.getElementById('rt-estimate').value = String(draft.estimate_minutes || 30);
  const business = document.getElementById('rt-business');
  if (business) business.value = draft.business || '';
  const revenue = document.getElementById('rt-revenue');
  if (revenue) revenue.checked = !!draft.revenue;
  const weekend = document.getElementById('rt-weekend');
  if (weekend) weekend.checked = !!draft.weekend_scheduled;
  document.getElementById('rt-title').focus();
}

function syncDraftFromForm() {
  const draft = state.modal;
  if (!draft) return;
  const title = document.getElementById('rt-title');
  if (!title) return;
  const previousDue = draft.due_date;
  draft.title = title.value;
  draft.notes = document.getElementById('rt-notes').value;
  draft.due_date = document.getElementById('rt-due').value;
  draft.status = document.getElementById('rt-status').value;
  draft.category = document.getElementById('rt-category').value;
  draft.priority = Number(document.getElementById('rt-priority').value);
  draft.estimate_minutes = Number(document.getElementById('rt-estimate').value);
  const business = document.getElementById('rt-business');
  draft.business = business ? (business.value || null) : null;
  const revenue = document.getElementById('rt-revenue');
  draft.revenue = revenue ? revenue.checked : false;
  const weekend = document.getElementById('rt-weekend');
  draft.weekend_scheduled = weekend ? weekend.checked : false;
  if (!draft.id && draft.due_date && isWeekendIso(draft.due_date) && previousDue !== draft.due_date) {
    draft.weekend_scheduled = true;
    if (weekend) weekend.checked = true;
  }
  if (draft.category === 'personal') {
    draft.business = null;
    draft.revenue = false;
  }
}

function updateWarning() {
  const warn = document.getElementById('rt-warn');
  const save = document.getElementById('rt-save');
  if (!warn || !save || !state.modal) return;
  const text = warningText(loadWarning(state.modal));
  warn.hidden = !text;
  warn.textContent = text;
  save.textContent = text ? 'Save anyway' : 'Save';
}

function renderHours() {
  const host = document.getElementById('rt-hours');
  if (!host) return;
  if (!state.hoursOpen) {
    host.innerHTML = '';
    return;
  }
  const prefs = settings();
  const days = WEEKDAYS.map((name, index) => {
    const window = prefs.work_windows[String(index)];
    return `<div class="rt-hours-day">
      <span>${name.slice(0, 3)}</span>
      <input id="rt-win-on-${index}" type="checkbox" ${window.enabled ? 'checked' : ''} aria-label="${name} enabled">
      <input id="rt-win-start-${index}" type="time" value="${window.start}">
      <input id="rt-win-end-${index}" type="time" value="${window.end}">
    </div>`;
  }).join('');
  host.innerHTML = `<div class="rt-drawer-back"><div class="rt-drawer">
    <div class="sec-title">Hours & calendar</div>
    <p class="sec-sub">Google Calendar fills the gaps inside the working-day window. Manual blocks are the fallback when the calendar is not connected. Events whose titles contain a keyword (Focus, Work block, Tasks) stay available. All-day events and events marked free are ignored. Gaps under the minimum are skipped.</p>
    <div class="rt-form">
      <label>Timezone <input id="rt-tz" type="text" value="${esc(prefs.timezone)}"></label>
      <label>Available-title keywords <input id="rt-keywords" type="text" value="${esc(prefs.focus_keywords)}"></label>
      <div class="rt-split">
        <label>Minimum gap (minutes) <input id="rt-gap" type="number" min="0" max="240" value="${prefs.min_gap_minutes}"></label>
        <label class="rt-check"><input id="rt-allday" type="checkbox" ${prefs.ignore_all_day ? 'checked' : ''}><span>Ignore all-day events</span></label>
      </div>
      <label class="rt-check"><input id="rt-transparent" type="checkbox" ${prefs.ignore_transparent ? 'checked' : ''}><span>Ignore events marked free</span></label>
      <div class="sec-title" style="font-size:1.1rem">Working-day window</div>
      ${days}
      <div class="sec-title" style="font-size:1.1rem">Manual blocks</div>
      <div id="rt-block-list"></div>
      <div class="rt-split">
        <label>Day <select id="rt-block-day">${WEEKDAYS.map((name, index) => `<option value="${index}">${name}</option>`).join('')}</select></label>
        <label>Start <input id="rt-block-start" type="time" value="07:00"></label>
      </div>
      <label>End <input id="rt-block-end" type="time" value="09:00"></label>
      <div class="rt-row">
        <button type="button" class="tbtn" data-action="add-block">Add block</button>
        <button type="button" class="tbtn" data-action="sample-blocks">Weekday sample 7–9 and 1–3:30</button>
      </div>
      <div class="rt-row">
        <button type="button" class="btn-g" data-action="save-hours">Save hours</button>
        <button type="button" class="tbtn" data-action="close-hours">Close</button>
      </div>
    </div>
  </div></div>`;
  renderBlockList();
}

function renderBlockList() {
  const host = document.getElementById('rt-block-list');
  if (!host) return;
  host.innerHTML = state.blockDraft.length
    ? state.blockDraft.map((block, index) => `<div class="rt-block-line"><span>${esc(WEEKDAYS[block.weekday])} ${esc(block.start)}–${esc(block.end)}</span><button type="button" class="tbtn" data-action="remove-block" data-index="${index}">Remove</button></div>`).join('')
    : '<div class="rt-empty">No manual blocks yet. The sample button adds 7:00–9:00 and 13:00–15:30 on weekdays.</div>';
}

function blankTask() {
  const today = displayedToday();
  return {
    id: null,
    title: '',
    notes: '',
    due_date: state.view === 'today' ? today : '',
    status: 'todo',
    category: state.view === 'personal' ? 'personal' : 'work',
    business: state.view === 'work' && !['all', 'untagged'].includes(state.biz) ? state.biz : null,
    estimate_minutes: 30,
    priority: 2,
    sort_order: nextSort('todo'),
    placement: 'auto',
    pin_date: null,
    pin_start_minute: null,
    weekend_scheduled: state.view === 'today' && isWeekendIso(today),
    revenue: false,
    created_at: null,
  };
}

function nextSort(status) {
  const values = state.tasks.filter(task => task.status === status).map(task => Number(task.sort_order) || 0);
  return values.length ? Math.max(...values) + 1 : 0;
}

function toRow(task, insert) {
  let placement = task.placement || 'auto';
  let pinDate = task.pin_date || null;
  let pinStart = task.pin_start_minute == null || task.pin_start_minute === '' ? null : Number(task.pin_start_minute);
  if (placement === 'window' && (!pinDate || pinStart == null)) placement = 'auto';
  if (placement === 'overflow' && !pinDate) placement = 'auto';
  if (placement === 'auto') {
    pinDate = null;
    pinStart = null;
  }
  if (placement === 'overflow') pinStart = null;
  const category = task.category === 'personal' ? 'personal' : 'work';
  const row = {
    title: String(task.title || '').trim(),
    notes: String(task.notes || ''),
    due_date: task.due_date || null,
    status: STATUSES.some(item => item.id === task.status) ? task.status : 'todo',
    category,
    business: category === 'personal' ? null : (task.business || null),
    estimate_minutes: clampEstimate(task.estimate_minutes),
    priority: [1, 2, 3].includes(Number(task.priority)) ? Number(task.priority) : 2,
    sort_order: Number.isFinite(Number(task.sort_order)) ? Number(task.sort_order) : 0,
    pin_date: pinDate,
    pin_start_minute: pinStart,
    placement,
    weekend_scheduled: !!task.weekend_scheduled,
    revenue: category === 'work' && !!task.revenue,
  };
  if (insert) row.user_id = state.session.user.id;
  return row;
}

async function persist(task) {
  const insert = !task.id;
  const row = toRow(task, insert);
  if (!row.title) throw new Error('title');
  const query = insert
    ? db().from('running_tasks').insert(row).select().single()
    : db().from('running_tasks').update(row).eq('id', task.id).select().single();
  const { data, error } = await query;
  if (error) throw error;
  const index = state.tasks.findIndex(item => item.id === data.id);
  if (index >= 0) state.tasks[index] = data;
  else state.tasks.push(data);
  return data;
}

async function persistMany(tasks) {
  for (const task of tasks) await persist(task);
}

function friendlyError(error) {
  const message = String(error && (error.message || error) || '');
  if (/running_tasks|schema cache|does not exist|relation/i.test(message)) {
    return 'The running list is not in the database yet. Run supabase/migrations/20261023223000_running_tasks.sql in the Driven-110 SQL editor, then reload.';
  }
  return 'Could not load the running list. Check the connection and try again.';
}

async function ensureSettings() {
  const uid = state.session.user.id;
  const existing = await db().from('running_schedule_settings').select('user_id').eq('user_id', uid).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;
  const prefs = defaultSettings(guessTimeZone());
  const inserted = await db().from('running_schedule_settings').insert({ user_id: uid, ...prefs });
  if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
}

async function refresh() {
  const uid = state.session.user.id;
  const [tasksRes, settingsRes] = await Promise.all([
    db().from('running_tasks').select('*').eq('user_id', uid).order('sort_order', { ascending: true }),
    db().from('running_schedule_settings').select('*').eq('user_id', uid).maybeSingle(),
  ]);
  if (tasksRes.error) throw tasksRes.error;
  if (settingsRes.error) throw settingsRes.error;
  state.tasks = tasksRes.data || [];
  state.settings = normalizeSettings(settingsRes.data, guessTimeZone());
  state.loadError = '';
  renderMain();
}

function stopChannel() {
  if (state.channel) {
    db().removeChannel(state.channel);
    state.channel = null;
  }
}

function scheduleReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(() => {
    if (state.dragging || state.modal || state.hoursOpen || !state.session) return;
    refresh().catch(() => {});
  }, 400);
}

function subscribe() {
  stopChannel();
  const id = state.session.user.id;
  state.channel = db().channel(`running-${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'running_tasks', filter: `user_id=eq.${id}` }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'running_schedule_settings', filter: `user_id=eq.${id}` }, scheduleReload)
    .subscribe();
}

async function fetchCalendar(force) {
  if (!state.session) return;
  const fresh = state.calendar.fetchedAt && Date.now() - new Date(state.calendar.fetchedAt).getTime() < 5 * 60 * 1000;
  if (!force && fresh) return;
  if (!force && state.calendarChecked && Date.now() - state.calendarChecked < 60 * 1000) return;
  state.calendarChecked = Date.now();
  if (previewOn()) {
    state.calendar = { status: 'preview', fetchedAt: new Date().toISOString(), days: {}, timezoneApplied: true, reason: '' };
    renderMain();
    return;
  }
  state.calendar = { ...state.calendar, status: 'loading' };
  const status = document.querySelector('.rt-status span');
  if (status) status.textContent = statusLine();
  const dates = [];
  let cursor = realToday();
  const shown = displayedToday();
  for (let i = 0; i < 14; i += 1) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  if (!dates.includes(shown)) dates.push(shown);
  const { data, error } = await db().functions.invoke('calendar-availability', {
    body: { dates, timezone: settings().timezone },
  });
  if (!state.session) return;
  if (error || !data) {
    state.calendar = { status: 'manual', fetchedAt: null, days: {}, timezoneApplied: true, reason: 'unavailable' };
  } else if (!data.configured) {
    state.calendar = { status: 'manual', fetchedAt: null, days: {}, timezoneApplied: true, reason: data.reason || 'not_configured' };
  } else if (data.reason === 'fetch_failed') {
    state.calendar = { status: 'manual', fetchedAt: null, days: {}, timezoneApplied: true, reason: 'fetch_failed' };
  } else {
    state.calendar = {
      status: 'calendar',
      fetchedAt: data.fetchedAt,
      days: data.days || {},
      timezoneApplied: data.timezoneApplied !== false,
      reason: '',
    };
  }
  renderMain();
}

async function start() {
  const id = state.session && state.session.user && state.session.user.id;
  if (!id || state.bootedFor === id) {
    renderMain();
    return;
  }
  state.bootedFor = id;
  try {
    await ensureSettings();
    const seed = await db().rpc('seed_running_tasks');
    state.seedError = seed.error ? 'Starter tasks are waiting on the database migration.' : '';
    await refresh();
    subscribe();
    fetchCalendar();
  } catch (error) {
    state.bootedFor = null;
    state.loadError = friendlyError(error);
    renderMain();
  }
}

function closeModal() {
  state.modal = null;
  renderModal();
}

async function saveModal() {
  syncDraftFromForm();
  if (!state.modal.title.trim()) {
    toast('Add a title', 'err');
    return;
  }
  const original = state.tasks.find(task => task.id === state.modal.id);
  if (original && original.due_date !== state.modal.due_date) {
    state.modal.placement = 'auto';
    state.modal.pin_date = null;
    state.modal.pin_start_minute = null;
  }
  try {
    await persist(state.modal);
    closeModal();
    renderMain();
    toast('Task saved', 'ok');
  } catch {
    toast('Save failed', 'err');
  }
}

async function removeTask() {
  const id = state.modal && state.modal.id;
  if (!id || !confirm('Delete this task?')) return;
  const { error } = await db().from('running_tasks').delete().eq('id', id);
  if (error) {
    toast('Delete failed', 'err');
    return;
  }
  state.tasks = state.tasks.filter(task => task.id !== id);
  closeModal();
  renderMain();
  toast('Task deleted', 'ok');
}

function dayIsFull(dateIso, task) {
  const draft = {
    ...task,
    due_date: dateIso,
    status: 'todo',
    weekend_scheduled: isWeekendIso(dateIso) ? true : task.weekend_scheduled,
  };
  const info = loadWarning(draft);
  return info && (info.over || (info.available === 0 && info.planned > 0)) ? info : null;
}

async function moveDue(task, dateIso) {
  const info = dayIsFull(dateIso, task);
  if (info) {
    const detail = info.available === 0
      ? `${formatLongDate(dateIso)} has no open hours`
      : `${formatLongDate(dateIso)} would be overbooked by ${formatDuration(info.overBy)} (${formatDuration(info.planned)} planned of ${formatDuration(info.available)})`;
    if (!confirm(`${detail}. Move this task there anyway?`)) return;
  }
  await persist({
    ...task,
    due_date: dateIso,
    weekend_scheduled: isWeekendIso(dateIso),
    placement: 'auto',
    pin_date: null,
    pin_start_minute: null,
  });
  renderMain();
  toast(`Due ${formatLongDate(dateIso)}`, 'ok');
}

function pickDay(taskId) {
  let input = document.getElementById('rt-daypick');
  if (!input) {
    input = document.createElement('input');
    input.type = 'date';
    input.id = 'rt-daypick';
    input.style.position = 'fixed';
    input.style.left = '-999px';
    document.body.appendChild(input);
  }
  input.value = '';
  input.onchange = () => {
    const task = state.tasks.find(item => item.id === taskId);
    if (task && input.value) moveDue(task, input.value).catch(() => toast('Could not move that task', 'err'));
  };
  if (input.showPicker) input.showPicker();
  else input.click();
}

function idsFromZone(zone, draggedId, clientY) {
  const cards = [...zone.querySelectorAll('[data-task-id]')].filter(card => card.dataset.taskId !== draggedId);
  let index = cards.length;
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      index = i;
      break;
    }
  }
  const ids = cards.map(card => card.dataset.taskId);
  ids.splice(index, 0, draggedId);
  return ids;
}

function blendOrder(existing, visibleIds, dragged) {
  const visible = new Set(visibleIds);
  const ordered = [];
  let placed = false;
  const pushVisible = () => {
    visibleIds.forEach(id => {
      const task = id === dragged.id ? dragged : state.tasks.find(item => item.id === id);
      if (task) ordered.push(task);
    });
    placed = true;
  };
  existing.forEach(task => {
    if (task.id === dragged.id) return;
    if (visible.has(task.id)) {
      if (!placed) pushVisible();
      return;
    }
    ordered.push(task);
  });
  if (!placed) pushVisible();
  return ordered;
}

async function dropOnStatus(task, zone, clientY) {
  const status = zone.dataset.dropValue;
  const visibleIds = idsFromZone(zone, task.id, clientY);
  const dragged = {
    ...task,
    status,
    placement: status === 'done' ? 'auto' : task.placement,
    pin_date: status === 'done' ? null : task.pin_date,
    pin_start_minute: status === 'done' ? null : task.pin_start_minute,
  };
  const existing = state.tasks.filter(item => item.status === status && item.id !== task.id)
    .sort((a, b) => a.sort_order - b.sort_order);
  const ordered = blendOrder(existing, visibleIds, dragged);
  const changes = ordered.map((item, index) => ({ ...item, sort_order: index, status: item.id === task.id ? status : item.status }));
  await persistMany(changes.filter((item, index) => {
    const previous = state.tasks.find(taskItem => taskItem.id === item.id);
    return !previous || previous.sort_order !== index || previous.status !== item.status || previous.placement !== item.placement;
  }));
}

async function dropOnWindow(task, zone, clientY) {
  const start = Number(zone.dataset.dropValue);
  const today = displayedToday();
  const schedule = windowsFor(today);
  const window = schedule.free.find(item => item.start === start);
  if (!window) return;
  const visibleIds = idsFromZone(zone, task.id, clientY);
  let remaining = window.end - window.start;
  const changes = [];
  visibleIds.forEach((id, index) => {
    const source = id === task.id ? task : state.tasks.find(item => item.id === id);
    if (!source) return;
    const estimate = clampEstimate(source.estimate_minutes);
    const fits = estimate <= remaining;
    if (fits) remaining -= estimate;
    changes.push({
      ...source,
      sort_order: index,
      weekend_scheduled: id === task.id && isWeekendIso(today) ? true : source.weekend_scheduled,
      placement: fits ? 'window' : 'overflow',
      pin_date: today,
      pin_start_minute: fits ? start : null,
    });
  });
  if (changes.some(item => item.id === task.id && item.placement === 'overflow')) {
    toast('That block does not have room for this task', 'err');
  }
  await persistMany(changes);
}

async function dropOnOverflow(task) {
  const today = displayedToday();
  await persist({
    ...task,
    placement: 'overflow',
    pin_date: today,
    pin_start_minute: null,
    weekend_scheduled: isWeekendIso(today) ? true : task.weekend_scheduled,
  });
}

async function dropOnMonday(task) {
  if (task.category === 'personal' || !isRevenueTask({ ...task, weekend_scheduled: false })) {
    toast('Only revenue-producing work is held for Monday. Driven tasks count, or turn on Revenue-producing.', 'err');
    return;
  }
  await persist({
    ...task,
    weekend_scheduled: false,
    placement: 'auto',
    pin_date: null,
    pin_start_minute: null,
  });
}

async function applyDrop(taskId, zone, clientY) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || !zone) return;
  const kind = zone.dataset.drop;
  try {
    if (kind === 'status') await dropOnStatus(task, zone, clientY);
    else if (kind === 'window') await dropOnWindow(task, zone, clientY);
    else if (kind === 'overflow') await dropOnOverflow(task);
    else if (kind === 'monday') await dropOnMonday(task);
    renderMain();
  } catch {
    toast('Could not move that task', 'err');
    refresh().catch(() => {});
  }
}

function clearDrag(pointer) {
  document.body.classList.remove('rt-dragging');
  if (pointer.card) pointer.card.classList.remove('rt-card-ghosting');
  if (pointer.ghost) pointer.ghost.remove();
  document.querySelectorAll('.rt-drop-on').forEach(node => node.classList.remove('rt-drop-on'));
  pointer.handle.removeEventListener('pointermove', pointer.move);
  pointer.handle.removeEventListener('pointerup', pointer.up);
  pointer.handle.removeEventListener('pointercancel', pointer.up);
  state.dragging = false;
}

function onPointerDown(event) {
  const handle = event.target.closest('[data-drag-handle]');
  if (!handle || event.button > 0) return;
  const card = handle.closest('[data-task-id]');
  if (!card) return;
  const pointer = {
    id: event.pointerId,
    taskId: card.dataset.taskId,
    startX: event.clientX,
    startY: event.clientY,
    card,
    handle,
    dragging: false,
    zone: null,
    lastY: event.clientY,
  };
  pointer.move = moveEvent => onPointerMove(pointer, moveEvent);
  pointer.up = upEvent => onPointerUp(pointer, upEvent);
  handle.setPointerCapture(event.pointerId);
  handle.addEventListener('pointermove', pointer.move);
  handle.addEventListener('pointerup', pointer.up);
  handle.addEventListener('pointercancel', pointer.up);
}

function onPointerMove(pointer, event) {
  if (event.pointerId !== pointer.id) return;
  const distance = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
  if (!pointer.dragging) {
    if (distance < 8) return;
    pointer.dragging = true;
    state.dragging = true;
    document.body.classList.add('rt-dragging');
    pointer.card.classList.add('rt-card-ghosting');
    pointer.ghost = pointer.card.cloneNode(true);
    pointer.ghost.classList.add('rt-ghost');
    pointer.ghost.style.width = `${pointer.card.getBoundingClientRect().width}px`;
    document.body.appendChild(pointer.ghost);
  }
  event.preventDefault();
  pointer.lastY = event.clientY;
  pointer.ghost.style.left = `${event.clientX - 28}px`;
  pointer.ghost.style.top = `${event.clientY - 18}px`;
  if (event.clientY < 72) window.scrollBy(0, -14);
  else if (event.clientY > window.innerHeight - 72) window.scrollBy(0, 14);
  pointer.ghost.hidden = true;
  const under = document.elementFromPoint(event.clientX, event.clientY);
  pointer.ghost.hidden = false;
  const zone = under && under.closest('[data-drop]');
  document.querySelectorAll('.rt-drop-on').forEach(node => node.classList.remove('rt-drop-on'));
  if (zone) zone.classList.add('rt-drop-on');
  pointer.zone = zone || null;
}

function onPointerUp(pointer, event) {
  const dragged = pointer.dragging;
  const zone = pointer.zone;
  const taskId = pointer.taskId;
  const y = pointer.lastY;
  clearDrag(pointer);
  if (!dragged) return;
  state.suppressClick = true;
  applyDrop(taskId, zone, y);
}

function readHours() {
  const workWindows = {};
  for (let day = 0; day < 7; day += 1) {
    workWindows[String(day)] = {
      enabled: document.getElementById(`rt-win-on-${day}`).checked,
      start: document.getElementById(`rt-win-start-${day}`).value,
      end: document.getElementById(`rt-win-end-${day}`).value,
    };
  }
  return normalizeSettings({
    work_windows: workWindows,
    manual_blocks: state.blockDraft,
    focus_keywords: document.getElementById('rt-keywords').value,
    min_gap_minutes: Number(document.getElementById('rt-gap').value),
    ignore_all_day: document.getElementById('rt-allday').checked,
    ignore_transparent: document.getElementById('rt-transparent').checked,
    timezone: document.getElementById('rt-tz').value.trim(),
  }, guessTimeZone());
}

async function saveHours() {
  const prefs = readHours();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: prefs.timezone }).format();
  } catch {
    toast('That timezone was not recognized', 'err');
    return;
  }
  const { error } = await db().from('running_schedule_settings').upsert({
    user_id: state.session.user.id,
    ...prefs,
  }, { onConflict: 'user_id' });
  if (error) {
    toast('Could not save hours', 'err');
    return;
  }
  state.settings = prefs;
  state.hoursOpen = false;
  renderHours();
  renderMain();
  fetchCalendar();
  toast('Hours saved', 'ok');
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const email = document.getElementById('rt-email').value.trim();
  const password = document.getElementById('rt-password').value;
  if (password.length < 8) {
    state.authError = 'Use at least 8 characters.';
    renderMain();
    return;
  }
  state.authBusy = true;
  state.authError = '';
  renderMain();
  const action = state.authMode === 'signup'
    ? db().auth.signUp({ email, password })
    : db().auth.signInWithPassword({ email, password });
  const { data, error } = await action;
  state.authBusy = false;
  if (error) {
    state.authError = 'That email or password was not accepted.';
    renderMain();
    return;
  }
  if (state.authMode === 'signup' && !data.session) {
    state.authError = 'Check your email to confirm the account, then sign in. If no email arrives, confirm the user in Supabase Authentication.';
    state.authMode = 'signin';
    renderMain();
  }
}

function onClick(event) {
  if (state.suppressClick) {
    state.suppressClick = false;
    return;
  }
  const actionNode = event.target.closest('[data-action]');
  if (!actionNode) return;
  const action = actionNode.dataset.action;
  const id = actionNode.dataset.id;
  if (action === 'auth-mode') {
    state.authMode = state.authMode === 'signup' ? 'signin' : 'signup';
    state.authError = '';
    renderMain();
    return;
  }
  if (action === 'view') {
    state.view = actionNode.dataset.view;
    if (state.view !== 'work' && state.view !== 'all') state.biz = 'all';
    renderMain();
    return;
  }
  if (action === 'biz') {
    state.biz = actionNode.dataset.biz;
    renderMain();
    return;
  }
  if (action === 'add') {
    state.modal = blankTask();
    renderModal();
    return;
  }
  if (action === 'edit') {
    const task = state.tasks.find(item => item.id === id);
    if (task) {
      state.modal = { ...task };
      renderModal();
    }
    return;
  }
  if (action === 'close-modal') {
    closeModal();
    return;
  }
  if (action === 'save-task') {
    saveModal();
    return;
  }
  if (action === 'delete-task') {
    removeTask();
    return;
  }
  if (action === 'preset') {
    const input = document.getElementById('rt-estimate');
    if (input && state.modal) {
      input.value = actionNode.dataset.minutes;
      syncDraftFromForm();
      updateWarning();
    }
    return;
  }
  if (action === 'hours') {
    state.blockDraft = settings().manual_blocks.map(block => ({ ...block }));
    state.hoursOpen = true;
    renderHours();
    return;
  }
  if (action === 'close-hours') {
    state.hoursOpen = false;
    renderHours();
    return;
  }
  if (action === 'save-hours') {
    saveHours();
    return;
  }
  if (action === 'add-block') {
    const weekday = Number(document.getElementById('rt-block-day').value);
    const start = document.getElementById('rt-block-start').value;
    const end = document.getElementById('rt-block-end').value;
    if (!start || !end || end <= start) {
      toast('End time has to be after the start', 'err');
      return;
    }
    state.blockDraft.push({ weekday, start, end });
    renderBlockList();
    return;
  }
  if (action === 'remove-block') {
    state.blockDraft.splice(Number(actionNode.dataset.index), 1);
    renderBlockList();
    return;
  }
  if (action === 'sample-blocks') {
    state.blockDraft = [];
    [1, 2, 3, 4, 5].forEach(weekday => {
      state.blockDraft.push({ weekday, start: '07:00', end: '09:00' });
      state.blockDraft.push({ weekday, start: '13:00', end: '15:30' });
    });
    renderBlockList();
    return;
  }
  if (action === 'refresh-cal') {
    fetchCalendar(true);
    return;
  }
  if (action === 'sign-out') {
    state.bootedFor = null;
    stopChannel();
    db().auth.signOut();
    return;
  }
  if (action === 'push-tomorrow') {
    const task = state.tasks.find(item => item.id === id);
    if (task) moveDue(task, addDays(displayedToday(), 1)).catch(() => toast('Could not move that task', 'err'));
    return;
  }
  if (action === 'pick-day') {
    pickDay(id);
    return;
  }
  if (action === 'keep-weekend') {
    const task = state.tasks.find(item => item.id === id);
    if (task) persist({ ...task, weekend_scheduled: true }).then(() => renderMain()).catch(() => toast('Could not update that task', 'err'));
    return;
  }
  if (action === 'commit-monday') {
    const task = state.tasks.find(item => item.id === id);
    const monday = nextMonday(displayedToday());
    if (!task || !confirm(`Set the due date to ${formatLongDate(monday)}? It stays ${task.due_date ? formatShortDate(task.due_date) : 'unset'} until you confirm.`)) return;
    persist({
      ...task,
      due_date: monday,
      weekend_scheduled: false,
      placement: 'auto',
      pin_date: null,
      pin_start_minute: null,
    }).then(() => renderMain()).catch(() => toast('Could not update that task', 'err'));
  }
}

function onChange(event) {
  if (event.target.id === 'rt-category' && state.modal) {
    syncDraftFromForm();
    renderModal();
    return;
  }
  if (state.modal && event.target.closest('#rt-modal')) {
    syncDraftFromForm();
    updateWarning();
  }
}

function onInput(event) {
  if (state.modal && event.target.closest('#rt-modal') && event.target.id !== 'rt-category') {
    syncDraftFromForm();
    updateWarning();
  }
}

const AREA_PRESET = {
  driven: { view: 'work', biz: 'driven' },
  tb: { view: 'work', biz: 'trailblazers' },
  life: { view: 'personal', biz: 'all' },
  ground: { view: 'work', biz: 'ground_up' },
};

function applyAreaPreset(area) {
  const preset = AREA_PRESET[area];
  if (!preset) return;
  state.view = preset.view;
  state.biz = preset.biz;
  if (document.getElementById('rt-main')) renderMain();
}

function mount() {
  const panel = document.getElementById('panel-running');
  if (!panel || panel.dataset.ready) return;
  panel.dataset.ready = '1';
  panel.innerHTML = '<div id="rt-main"></div><div id="rt-modal"></div><div id="rt-hours"></div>';
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
  panel.addEventListener('input', onInput);
  panel.addEventListener('pointerdown', onPointerDown);
  panel.addEventListener('submit', event => {
    if (event.target.id === 'rt-auth-form') onAuthSubmit(event);
  });
  const previous = window.showPanel;
  window.showPanel = function showPanelWrapped(id, el) {
    previous(id, el);
    if (id === 'running' && state.session) fetchCalendar(false);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.session) refresh().catch(() => {});
  });
  db().auth.getSession().then(({ data }) => {
    state.session = data.session;
    if (state.session) start();
    else renderMain();
  });
  window.addEventListener('cc-area', event => {
    applyAreaPreset(event.detail && event.detail.area);
  });
  db().auth.onAuthStateChange((_event, session) => {
    const previousId = state.session && state.session.user && state.session.user.id;
    state.session = session;
    const nextId = session && session.user && session.user.id;
    if (nextId && nextId !== previousId) start();
    else if (!nextId) {
      state.bootedFor = null;
      state.tasks = [];
      stopChannel();
      renderMain();
    }
  });
}

mount();
