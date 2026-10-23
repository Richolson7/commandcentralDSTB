const test = require('node:test');
const assert = require('node:assert/strict');
const SaveGuard = require('../js/save-guard.js');

const TASK = { id: 1, text: 'Call the crew', owner: 'Ops', due: '2026-05-07', done: false, category: 'Ops', priority: 'High' };
const EXTRA = { id: 2, text: 'Added on the L10 page', owner: 'Admin', due: '2026-05-08', done: false, category: 'General', priority: 'Medium' };

function readyEdits(overrides) {
  const edits = SaveGuard.snapshotEdits(SaveGuard.createMemory());
  edits.loadState = 'ready';
  return Object.assign(edits, overrides || {});
}

function fakeDb(row, opts) {
  const calls = [];
  let reads = 0;
  const secondRow = opts && opts.secondRow;
  return {
    calls,
    async readRow(id) {
      reads += 1;
      calls.push({ op: 'read', id, n: reads });
      if (reads > 1 && secondRow) return secondRow;
      return row;
    },
    async update(id, patch, updatedAt) {
      calls.push({ op: 'update', id, patch, updatedAt });
      if (opts && opts.rejectVersion && updatedAt) return false;
      return opts && opts.match === false ? false : true;
    },
  };
}

test('a failed or unfinished load never reads or writes', async () => {
  for (const loadState of ['error', 'loading', undefined]) {
    const edits = readyEdits({ loadState, weekDirty: { revenue_weekly_w4: 1 }, deletedTaskIds: [1] });
    let touched = false;
    const db = {
      async readRow() { touched = true; throw new Error('should not read'); },
      async update() { touched = true; throw new Error('should not write'); },
    };
    const result = await SaveGuard.commitEdits(db, 'tb_cmd', edits);
    assert.equal(touched, false);
    assert.equal(result.wrote, false);
    assert.equal(result.ok, false);
    assert.match(result.message, /Nothing was saved|can't overwrite/);
  }
});

test('default memory is not a successful load, so it cannot save', async () => {
  const mem = SaveGuard.createMemory();
  SaveGuard.noteWeekEdit(mem, 'revenue_weekly_w4', 5);
  let touched = false;
  const db = {
    async readRow() { touched = true; },
    async update() { touched = true; },
  };
  const result = await SaveGuard.commitEdits(db, 'tb_cmd', SaveGuard.snapshotEdits(mem));
  assert.equal(touched, false);
  assert.equal(result.wrote, false);
});

test('a number edit does not send tasks, history, or another page\'s columns', async () => {
  const db = fakeDb({
    updated_at: '2026-10-22T20:36:49.866Z',
    tasks: [TASK, EXTRA],
    history: [{ date: '2026-10-16', revenue_weekly: 10 }],
    week_data: { revenue_weekly_w4: 10, secret_key: 0, equipment_note: 'leave me' },
    equipment: [{ id: 9, name: 'mower' }],
    pm_schedule: [{ id: 3 }],
    maint_issues: [{ id: 4 }],
    truck_checks: [{ id: 5 }],
    rocks: [{ id: 6 }],
    pnl: { income: 100 },
  });
  const edits = readyEdits({ weekDirty: { revenue_weekly_w4: 42 } });
  const result = await SaveGuard.commitEdits(db, 'tb_cmd', edits);

  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  const patch = result.patch;
  assert.deepEqual(Object.keys(patch).sort(), ['updated_at', 'week_data']);
  assert.equal(patch.week_data.revenue_weekly_w4, 42);
  assert.equal(patch.week_data.secret_key, 0);
  assert.equal(patch.week_data.equipment_note, 'leave me');
  assert.equal(Object.hasOwn(patch, 'tasks'), false);
  for (const column of ['equipment', 'pm_schedule', 'maint_issues', 'truck_checks', 'rocks', 'issues', 'pnl', 'meeting_notes']) {
    assert.equal(Object.hasOwn(patch, column), false);
  }
  assert.equal(db.calls.filter(call => call.op === 'update')[0].updatedAt, '2026-10-22T20:36:49.866Z');
  assert.ok(SaveGuard.WRITABLE.every(column => ['week_data', 'history', 'tasks', 'updated_at'].includes(column)));
});

test('an empty in-memory task list is not an edit and does not erase saved to-dos', async () => {
  const db = fakeDb({ updated_at: 't1', tasks: [TASK], week_data: { revenue_weekly_w4: 10 }, history: [{ date: '2026-10-01' }] });
  const edits = readyEdits();
  const result = await SaveGuard.commitEdits(db, 'driven_cmd', edits);
  assert.equal(result.wrote, false);
  assert.equal(db.calls.some(call => call.op === 'update' || call.op === 'read'), false);
});

test('deleting the last to-do is refused unless this page confirmed the clear', async () => {
  const server = { updated_at: 't1', tasks: [TASK], week_data: {}, history: [] };
  const refusedDb = fakeDb(server);
  const refused = await SaveGuard.commitEdits(refusedDb, 'tb_cmd', readyEdits({ deletedTaskIds: [1] }));
  assert.equal(refused.wrote, false);
  assert.equal(refusedDb.calls.some(call => call.op === 'update'), false);
  assert.equal(refused.restoreTasks.length, 1);
  assert.equal(refused.restoreTasks[0].category, 'Ops');
  assert.ok(refused.warnings.includes(SaveGuard.MSG_TASKS_KEPT));

  const allowedDb = fakeDb(server);
  const allowed = await SaveGuard.commitEdits(allowedDb, 'tb_cmd', readyEdits({
    deletedTaskIds: [1],
    allowEmptyTasks: true,
  }));
  assert.equal(allowed.wrote, true);
  assert.deepEqual(allowed.patch.tasks, []);
});

test('a to-do edit keeps tasks added since load and keeps L10-only fields', async () => {
  const db = fakeDb({
    updated_at: 't1',
    tasks: [TASK],
    week_data: { revenue_weekly_w4: 3 },
    history: [],
  }, {
    rejectVersion: true,
    secondRow: {
      updated_at: 't2',
      tasks: [TASK, EXTRA],
      week_data: { revenue_weekly_w4: 3, jobs_completed_w4: 8 },
      history: [],
    },
  });
  const edits = readyEdits({ toggledDone: { 1: true } });
  const result = await SaveGuard.commitEdits(db, 'tb_cmd', edits);
  const writes = db.calls.filter(call => call.op === 'update');

  assert.equal(writes.length, 2);
  assert.equal(writes[0].updatedAt, 't1');
  assert.equal(writes[1].updatedAt, null);
  assert.equal(result.wrote, true);
  assert.equal(result.patch.tasks.length, 2);
  const kept = result.patch.tasks.find(task => task.id === 1);
  const added = result.patch.tasks.find(task => task.id === 2);
  assert.equal(kept.done, true);
  assert.equal(kept.category, 'Ops');
  assert.equal(kept.priority, 'High');
  assert.equal(added.text, 'Added on the L10 page');
  assert.equal(added.priority, 'Medium');
  assert.equal(Object.hasOwn(result.patch, 'week_data'), false);
});

test('history append and clear only change history', async () => {
  const db = fakeDb({
    updated_at: 't1',
    tasks: [TASK],
    week_data: { revenue_weekly_w4: 1 },
    history: [{ date: '2026-10-01', revenue_weekly: 4 }],
  });
  const snapshot = { date: '2026-10-22', revenue_weekly: 9 };
  const appended = await SaveGuard.commitEdits(db, 'driven_cmd', readyEdits({ pendingHistory: [snapshot] }));
  assert.deepEqual(appended.patch.history, [{ date: '2026-10-01', revenue_weekly: 4 }, snapshot]);
  assert.equal(Object.hasOwn(appended.patch, 'tasks'), false);

  const cleared = await SaveGuard.commitEdits(fakeDb({
    updated_at: 't1',
    tasks: [TASK],
    week_data: {},
    history: [{ date: '2026-10-01' }],
  }), 'driven_cmd', readyEdits({ historyClear: true, pendingHistory: [] }));
  assert.deepEqual(cleared.patch.history, []);
  assert.equal(Object.hasOwn(cleared.patch, 'tasks'), false);
});

test('a number edit still saves when an empty task wipe is refused', async () => {
  const db = fakeDb({ updated_at: 't1', tasks: [TASK], week_data: { revenue_weekly_w4: 2, other: 5 }, history: [] });
  const result = await SaveGuard.commitEdits(db, 'tb_cmd', readyEdits({
    weekDirty: { revenue_weekly_w4: 0 },
    deletedTaskIds: [1],
    allowEmptyTasks: false,
  }));
  assert.equal(result.wrote, true);
  assert.equal(result.patch.week_data.revenue_weekly_w4, 0);
  assert.equal(result.patch.week_data.other, 5);
  assert.equal(Object.hasOwn(result.patch, 'tasks'), false);
  assert.equal(result.restoreTasks[0].text, TASK.text);
});

test('realtime payload with no task list does not blank local to-dos', () => {
  const local = {
    data: { revenue_weekly_w4: 1 },
    history: [{ date: '2026-10-01' }],
    tasks: [TASK],
    pnl: { income: 20 },
  };
  const edits = SaveGuard.createMemory();
  edits.loadState = 'ready';
  const next = SaveGuard.applyRemoteSnapshot(local, edits, { week_data: { revenue_weekly_w4: 9 }, tasks: null, history: null });
  assert.equal(next.tasks[0].text, TASK.text);
  assert.equal(next.data.revenue_weekly_w4, 9);
  assert.equal(next.history.length, 1);

  edits.toggledDone['1'] = false;
  const duringEdit = SaveGuard.applyRemoteSnapshot(local, edits, { tasks: [] });
  assert.equal(duringEdit.tasks.length, 1);
});

test('loading a row adopts server tasks and does not mark them as edits', () => {
  const mem = SaveGuard.createMemory();
  const local = { data: {}, history: [], tasks: [], pnl: null };
  SaveGuard.absorbLoadedRow(mem, local, {
    week_data: { revenue_weekly_w4: 15 },
    history: [],
    tasks: [TASK],
    pnl: { net_income: 1 },
    updated_at: '2026-10-22T20:36:49.866Z',
    equipment: [{ id: 1 }],
  });
  assert.equal(mem.loadState, 'ready');
  assert.equal(local.tasks.length, 1);
  assert.equal(local.tasks[0].priority, 'High');
  assert.equal(local.data.revenue_weekly_w4, 15);
  assert.equal(SaveGuard.hasPendingEdits(mem), false);
  assert.equal(local.pnl.net_income, 1);
});

test('a new to-do is appended and does not strip fields on the saved list', () => {
  const merged = SaveGuard.mergeTasks([TASK], readyEdits({
    addedTasks: [{ id: 50, text: 'Order mulch', owner: 'Crew', due: '2026-05-09', done: false }],
  }));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].category, 'Ops');
  assert.equal(merged[1].text, 'Order mulch');
  assert.equal(Object.hasOwn(merged[1], 'category'), false);
});
