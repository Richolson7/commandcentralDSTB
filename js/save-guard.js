// Decides what the Command Center is allowed to write to dashboard_data.
// The page must not upsert a whole row from memory: that memory starts empty,
// and a save before a successful load (or after a failed one) used to replace
// saved to-dos and week numbers with that empty memory.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SaveGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const WRITABLE = ['week_data', 'history', 'tasks', 'updated_at'];
  const WRITABLE_SET = new Set(WRITABLE);

  const MSG_LOAD_FAILED = "Couldn't load saved data. Editing is locked so this page can't overwrite the team's numbers or to-dos. Retry, or refresh the page.";
  const MSG_STILL_LOADING = 'Still loading saved data. Nothing was saved yet.';
  const MSG_TASKS_KEPT = "Didn't clear the to-do list. The saved to-dos are still there. Refresh if this list looks empty.";
  const MSG_SAVE_FAILED = 'Save failed — the saved row was not updated.';

  function idKey(id) {
    return String(id);
  }

  function createMemory() {
    return {
      loadState: 'loading',
      weekDirty: {},
      pendingHistory: [],
      historyClear: false,
      addedTasks: [],
      deletedTaskIds: [],
      toggledDone: {},
      allowEmptyTasks: false,
    };
  }

  function hasTaskEdits(edits) {
    return !!(edits && (
      (edits.addedTasks && edits.addedTasks.length) ||
      (edits.deletedTaskIds && edits.deletedTaskIds.length) ||
      (edits.toggledDone && Object.keys(edits.toggledDone).length)
    ));
  }

  function hasPendingEdits(edits) {
    if (!edits) return false;
    return Object.keys(edits.weekDirty || {}).length > 0 ||
      !!edits.historyClear ||
      (edits.pendingHistory && edits.pendingHistory.length > 0) ||
      hasTaskEdits(edits);
  }

  function noteWeekEdit(mem, key, value) {
    mem.weekDirty[key] = value;
  }

  function noteHistoryAppend(mem, snapshot) {
    mem.pendingHistory.push(snapshot);
  }

  function noteHistoryClear(mem) {
    mem.historyClear = true;
    mem.pendingHistory = [];
  }

  function noteTaskAdded(mem, task) {
    mem.addedTasks.push(task);
    mem.allowEmptyTasks = false;
  }

  function noteTaskToggled(mem, id, done) {
    mem.toggledDone[idKey(id)] = !!done;
  }

  function noteTaskDeleted(mem, id) {
    const key = idKey(id);
    mem.deletedTaskIds.push(id);
    mem.addedTasks = mem.addedTasks.filter(task => idKey(task.id) !== key);
    delete mem.toggledDone[key];
  }

  function noteEmptyTasksAllowed(mem) {
    mem.allowEmptyTasks = true;
  }

  function snapshotEdits(mem) {
    return {
      loadState: mem.loadState,
      weekDirty: Object.assign({}, mem.weekDirty),
      pendingHistory: mem.pendingHistory.slice(),
      historyClear: !!mem.historyClear,
      addedTasks: mem.addedTasks.map(task => Object.assign({}, task)),
      deletedTaskIds: mem.deletedTaskIds.slice(),
      toggledDone: Object.assign({}, mem.toggledDone),
      allowEmptyTasks: !!mem.allowEmptyTasks,
    };
  }

  function discardTaskEdits(mem, edits) {
    const deleted = new Set((edits.deletedTaskIds || []).map(idKey));
    mem.deletedTaskIds = mem.deletedTaskIds.filter(id => !deleted.has(idKey(id)));
    const added = new Set((edits.addedTasks || []).map(task => idKey(task.id)));
    mem.addedTasks = mem.addedTasks.filter(task => !added.has(idKey(task.id)));
    Object.keys(edits.toggledDone || {}).forEach(key => { delete mem.toggledDone[key]; });
    if (!hasTaskEdits(mem)) mem.allowEmptyTasks = false;
  }

  function clearWritten(mem, edits, patch) {
    if (!patch) return;
    if (patch.week_data) {
      Object.keys(edits.weekDirty || {}).forEach(key => {
        if (mem.weekDirty[key] === edits.weekDirty[key]) delete mem.weekDirty[key];
      });
    }
    if (patch.history) {
      if (edits.historyClear) mem.historyClear = false;
      const written = new Set(edits.pendingHistory || []);
      mem.pendingHistory = mem.pendingHistory.filter(snapshot => !written.has(snapshot));
    }
    if (patch.tasks) discardTaskEdits(mem, edits);
  }

  function weekObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
  }

  function mergeTasks(serverTasks, edits) {
    const deleted = new Set((edits.deletedTaskIds || []).map(idKey));
    const result = [];
    const seen = new Set();
    (Array.isArray(serverTasks) ? serverTasks : []).forEach(raw => {
      if (!raw || typeof raw !== 'object') return;
      const key = idKey(raw.id);
      if (deleted.has(key)) return;
      const task = Object.assign({}, raw);
      if (Object.prototype.hasOwnProperty.call(edits.toggledDone, key)) task.done = edits.toggledDone[key];
      const added = (edits.addedTasks || []).find(item => idKey(item.id) === key);
      if (added) {
        task.text = added.text;
        task.owner = added.owner;
        task.due = added.due;
        if (!Object.prototype.hasOwnProperty.call(edits.toggledDone, key)) task.done = !!added.done;
      }
      result.push(task);
      seen.add(key);
    });
    (edits.addedTasks || []).forEach(added => {
      const key = idKey(added.id);
      if (deleted.has(key) || seen.has(key)) return;
      const task = {
        id: added.id,
        text: added.text,
        owner: added.owner,
        due: added.due,
        done: !!added.done,
      };
      if (Object.prototype.hasOwnProperty.call(edits.toggledDone, key)) task.done = edits.toggledDone[key];
      result.push(task);
    });
    return result;
  }

  // Build the column patch for one fresh server row. Does not include updated_at.
  function planWrite(edits, serverRow) {
    const row = serverRow || {};
    const serverTasks = Array.isArray(row.tasks) ? row.tasks : [];
    const serverWeek = weekObject(row.week_data);
    const serverHistory = Array.isArray(row.history) ? row.history : [];
    const patch = {};
    const warnings = [];
    let restoreTasks = null;

    const dirtyKeys = Object.keys(edits.weekDirty || {});
    if (dirtyKeys.length) {
      const mergedWeek = Object.assign({}, serverWeek);
      dirtyKeys.forEach(key => { mergedWeek[key] = edits.weekDirty[key]; });
      patch.week_data = mergedWeek;
    }

    if (edits.historyClear || (edits.pendingHistory && edits.pendingHistory.length)) {
      const base = edits.historyClear ? [] : serverHistory.slice();
      patch.history = base.concat(edits.pendingHistory || []);
    }

    if (hasTaskEdits(edits)) {
      const merged = mergeTasks(serverTasks, edits);
      const wouldErase = merged.length === 0 && serverTasks.length > 0;
      if (wouldErase && !edits.allowEmptyTasks) {
        warnings.push(MSG_TASKS_KEPT);
        restoreTasks = serverTasks.map(task => Object.assign({}, task));
      } else {
        patch.tasks = merged;
      }
    }

    return { patch, warnings, restoreTasks };
  }

  function assertWritable(patch) {
    Object.keys(patch).forEach(key => {
      if (!WRITABLE_SET.has(key)) {
        throw new Error('Refusing to write column ' + key);
      }
    });
  }

  function blocked(loadState) {
    return {
      ok: false,
      wrote: false,
      patch: null,
      warnings: [],
      restoreTasks: null,
      message: loadState === 'loading' ? MSG_STILL_LOADING : MSG_LOAD_FAILED,
    };
  }

  async function writePlan(db, rowId, edits, serverRow, useVersion) {
    const plan = planWrite(edits, serverRow);
    const patch = Object.assign({}, plan.patch);
    if (!Object.keys(patch).length) {
      return {
        ok: !plan.restoreTasks,
        wrote: false,
        patch: null,
        warnings: plan.warnings,
        restoreTasks: plan.restoreTasks,
        message: null,
        conflict: false,
      };
    }
    patch.updated_at = new Date().toISOString();
    assertWritable(patch);
    const version = useVersion && serverRow ? serverRow.updated_at : null;
    const matched = await db.update(rowId, patch, version || null);
    if (!matched) {
      if (useVersion) {
        return { ok: false, wrote: false, patch: null, warnings: plan.warnings, restoreTasks: null, message: null, conflict: true };
      }
      return { ok: false, wrote: false, patch: null, warnings: plan.warnings, restoreTasks: plan.restoreTasks, message: MSG_SAVE_FAILED, conflict: false };
    }
    return {
      ok: true,
      wrote: true,
      patch,
      warnings: plan.warnings,
      restoreTasks: plan.restoreTasks,
      message: null,
      conflict: false,
    };
  }

  // Read the row, merge this page's edits, and update only those columns.
  // If updated_at changed between the read and the write, re-read once and merge again.
  async function commitEdits(db, rowId, edits) {
    if (!edits || edits.loadState !== 'ready') return blocked(edits && edits.loadState);
    if (!hasPendingEdits(edits)) {
      return { ok: true, wrote: false, patch: null, warnings: [], restoreTasks: null, message: null };
    }
    const first = await db.readRow(rowId);
    const attempt = await writePlan(db, rowId, edits, first, true);
    if (!attempt.conflict) return attempt;
    const second = await db.readRow(rowId);
    return writePlan(db, rowId, edits, second, false);
  }

  function absorbLoadedRow(mem, local, row) {
    const week = weekObject(row && row.week_data);
    const history = row && Array.isArray(row.history) ? row.history : [];
    const tasks = row && Array.isArray(row.tasks) ? row.tasks : [];
    const pnl = row && Object.prototype.hasOwnProperty.call(row, 'pnl') ? row.pnl : null;
    if (hasPendingEdits(mem)) {
      local.data = Object.assign({}, week, mem.weekDirty);
      if (mem.historyClear) local.history = mem.pendingHistory.slice();
      else if (mem.pendingHistory.length) local.history = history.concat(mem.pendingHistory);
      else local.history = history;
      if (!hasTaskEdits(mem)) local.tasks = tasks;
      local.pnl = pnl;
    } else {
      local.data = week;
      local.history = history;
      local.tasks = tasks;
      local.pnl = pnl;
      mem.allowEmptyTasks = false;
    }
    mem.loadState = 'ready';
    return { updatedAt: row ? row.updated_at : null };
  }

  // Apply a realtime payload without turning a missing task list into [].
  function applyRemoteSnapshot(local, edits, row) {
    const next = {
      data: local.data,
      history: local.history,
      tasks: local.tasks,
      pnl: local.pnl,
    };
    if (!row || typeof row !== 'object') return next;
    const weekBusy = Object.keys((edits && edits.weekDirty) || {}).length > 0;
    if (row.week_data && typeof row.week_data === 'object' && !Array.isArray(row.week_data)) {
      next.data = weekBusy ? Object.assign({}, row.week_data, edits.weekDirty) : row.week_data;
    }
    const historyBusy = !!(edits && (edits.historyClear || (edits.pendingHistory && edits.pendingHistory.length)));
    if (!historyBusy && Array.isArray(row.history)) next.history = row.history;
    if (!hasTaskEdits(edits) && Array.isArray(row.tasks)) next.tasks = row.tasks;
    if (Object.prototype.hasOwnProperty.call(row, 'pnl')) next.pnl = row.pnl;
    return next;
  }

  return {
    WRITABLE,
    MSG_LOAD_FAILED,
    MSG_STILL_LOADING,
    MSG_TASKS_KEPT,
    MSG_SAVE_FAILED,
    createMemory,
    hasTaskEdits,
    hasPendingEdits,
    noteWeekEdit,
    noteHistoryAppend,
    noteHistoryClear,
    noteTaskAdded,
    noteTaskToggled,
    noteTaskDeleted,
    noteEmptyTasksAllowed,
    snapshotEdits,
    discardTaskEdits,
    clearWritten,
    mergeTasks,
    planWrite,
    commitEdits,
    absorbLoadedRow,
    applyRemoteSnapshot,
  };
});
