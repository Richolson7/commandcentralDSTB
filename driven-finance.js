/* Driven Finance Desk
   Reads fin_portal_read() only. Does not write dashboard_data, fin_config,
   or fin_weekly_log. Appends notes with fin_portal_append (insert only).
   Never sends email and never pays a bill. */
(function () {
  const SOURCE_ACTIONS = new Set(['portal_source_snapshot', 'bot_daily_cash_snapshot', 'bot_ap_snapshot']);
  let snaps = [];
  let view = 'cash';
  let timer = null;
  let drawing = false;

  function db() {
    return window.commandCenter && window.commandCenter.db;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function cents(n) { return Math.round(Number(n) * 100); }
  function money(n) {
    if (n === null || n === undefined || n === '') return 'Pending';
    const x = Number(n);
    if (!Number.isFinite(x)) return 'Pending';
    const body = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (x < 0 ? '-$' : '$') + body;
  }
  function fmtWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short'
    }).format(d) + ' CT';
  }
  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso + (String(iso).length === 10 ? 'T12:00:00' : ''));
    if (Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium' }).format(d);
  }
  function sources() { return snaps.filter(function (s) { return SOURCE_ACTIONS.has(s.action); }); }
  function newest(pred) {
    const rows = sources();
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i].payload || {};
      if (pred(p, rows[i])) return rows[i];
    }
    return null;
  }
  function num(p, keys) {
    if (!p) return null;
    for (let i = 0; i < keys.length; i++) {
      const v = p[keys[i]];
      if (v !== null && v !== undefined && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }
  function entries(action) {
    return snaps.filter(function (s) { return s.action === action; });
  }
  function vendorKey(name) { return String(name || '').trim().toLowerCase(); }
  function latestEntry(action, vendor, field) {
    const want = vendorKey(vendor);
    const rows = entries(action);
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i].payload || {};
      if (vendorKey(p.vendor) === want && p[field]) return { row: rows[i], value: p[field] };
    }
    return null;
  }
  function bookCash(p) {
    if (!p) return null;
    const direct = num(p, ['qbo_bank_cash', 'cash_driven_book']);
    if (direct !== null) return direct;
    const accounts = p.qbo_accounts || [];
    for (let i = 0; i < accounts.length; i++) {
      if (/checking/i.test(accounts[i].name || '')) return Number(accounts[i].balance);
    }
    return null;
  }
  function depositCash(p) {
    const direct = num(p, ['cash_to_deposit']);
    if (direct !== null) return direct;
    const accounts = (p && p.qbo_accounts) || [];
    for (let i = 0; i < accounts.length; i++) {
      if (/deposit/i.test(accounts[i].name || '')) return Number(accounts[i].balance);
    }
    return null;
  }
  function asOf(snap) {
    const p = (snap && snap.payload) || {};
    return p.qbo_as_of_central || (snap && snap.logged_at) || null;
  }
  function sourceLine(snap) {
    const p = (snap && snap.payload) || {};
    const when = asOf(snap);
    const book = /qbo|quickbooks/i.test(p.source || '') || p.qbo_bank_cash != null || p.ap_open_bills != null || p.ap_total != null;
    const bits = ['As of ' + fmtWhen(when)];
    if (book) bits.push('QuickBooks book, read-only');
    if (p.amber_source_date || p.amber_last_known_gross_bank_unmapped != null) bits.push('Amber sheet ' + (p.amber_source_date || 'on file'));
    bits.push(p.confirmation_status || 'Unconfirmed');
    return '<div class="sec-sub">' + esc(bits.join(' · ')) + '</div>';
  }
  function chip(kind, text) {
    return '<span class="src ' + kind + '">' + esc(text) + '</span>';
  }
  function card(display, label, kind, source, note) {
    const numeric = typeof display === 'number';
    const neg = numeric && display < 0;
    return '<div class="sum-card' + (neg ? ' red' : '') + '"><div class="sum-num' + (neg ? ' breach' : '') + '">' +
      (numeric ? money(display) : display) + '</div><div class="sum-lbl">' + esc(label) + '</div><div style="margin-top:8px">' +
      chip(kind, source) + '</div>' + (note ? '<div class="sec-sub" style="margin:8px 0 0">' + note + '</div>' : '') + '</div>';
  }
  function empty(title) {
    return '<div class="fin-note">' + esc(title) + '</div>';
  }
  function table(headers, rows) {
    return '<div class="fin-scroll"><table class="kpi-table"><thead><tr>' +
      headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function pendingBox(text) {
    return '<div class="fin-note">' + text + '</div>';
  }

  function cashSnap() {
    return newest(function (p) {
      return bookCash(p) !== null || num(p, ['amber_last_known_gross_bank_unmapped', 'amber_actual_cash']) !== null;
    });
  }
  function decisionSnap() {
    return newest(function (p) {
      return num(p, ['ar_open_invoices']) !== null || num(p, ['ap_open_bills', 'ap_total']) !== null || bookCash(p) !== null;
    });
  }
  function billSnap() {
    return newest(function (p) { return Array.isArray(p.bills) && p.bills.length; });
  }
  function redSnap() {
    return newest(function (p) { return Array.isArray(p.red_vendors) && p.red_vendors.length; });
  }

  function renderCash() {
    const snap = cashSnap();
    if (!snap) return empty('No cash snapshot is in the log yet. Pending Amber. No stand-in balance is shown.');
    const p = snap.payload || {};
    const book = bookCash(p);
    const deposit = depositCash(p);
    const undeposited = num(p, ['undeposited_funds_separate']);
    const sheetBank = num(p, ['amber_last_known_gross_bank_unmapped']);
    const actual = p.amber_actual_cash === null || p.amber_actual_cash === undefined ? null : Number(p.amber_actual_cash);
    const available = num(p, ['amber_available_to_use', 'amber_available_cash']);
    const formula = num(p, ['amber_last_known_reserve_adjusted_formula']);
    const gap = (sheetBank !== null && book !== null) ? (cents(sheetBank) - cents(book)) / 100 : null;
    let html = sourceLine(snap);
    html += '<div class="fin-grid">';
    html += card(book === null ? 'Pending' : book, 'CCF Checking — QuickBooks book', 'qbo', 'QuickBooks book', 'Book cash. Not a bank-available balance.');
    html += card(deposit === null ? 'Pending' : deposit, 'Cash to deposit — QuickBooks book', 'qbo', 'QuickBooks book', '');
    html += card(undeposited === null ? 'Pending' : undeposited, 'Undeposited funds', 'wait', 'Not bank cash', esc(p.undeposited_funds_note || 'Kept off the bank-cash line.'));
    html += card(sheetBank === null ? 'Pending' : sheetBank, 'Amber sheet bank', 'amber', 'Amber sheet ' + (p.amber_source_date || ''), esc(p.amber_gross_bank_note || 'Unconfirmed sheet figure. Not the QuickBooks book balance.'));
    html += card(actual === null || !Number.isFinite(actual) ? 'Pending' : actual, 'Amber confirmed bank cash', 'wait', 'Unconfirmed', 'Amber has not confirmed an actual bank balance on this snapshot.');
    html += card(available === null ? 'Pending' : available, 'Sheet “available to use”', 'amber', 'Amber sheet formula', esc(p.amber_available_note || 'Not raw bank cash.'));
    html += card(formula === null ? 'Pending' : formula, 'Sheet “Actual in Bank”', 'amber', 'Reserve-adjusted formula', esc(p.amber_reserve_adjusted_note || 'Not raw bank cash.'));
    html += card(gap === null ? 'Pending' : gap, 'Gap: sheet bank minus book', 'wait', 'Unconfirmed', 'Sheet bank and QuickBooks book are different sources. This gap is their difference, not spendable cash.');
    html += '</div>';
    if (p.amber_old_holding_checks != null || p.amber_mailed_not_cashed != null || p.amber_holding_note) {
      html += '<div class="fin-note">Old holding checks ' + (p.amber_old_holding_checks == null ? 'not on this snapshot' : money(p.amber_old_holding_checks)) +
        ' · mailed and not cashed ' + (p.amber_mailed_not_cashed == null ? 'not on this snapshot' : money(p.amber_mailed_not_cashed)) +
        '. ' + esc(p.amber_holding_note || 'Unconfirmed. Not treated as bank cash.') + '</div>';
    }
    if (p.amber_outflow_reserve != null) {
      html += '<div class="sec-sub">Outflow reserve on the sheet: ' + money(p.amber_outflow_reserve) + '. ' + esc(p.amber_outflow_reserve_note || '') + '</div>';
    }
    return html;
  }

  function renderDecisions() {
    const snap = decisionSnap();
    if (!snap) return empty('No cash, AR, or AP snapshot is in the log yet. Pending Amber.');
    const p = snap.payload || {};
    const book = bookCash(p);
    const sheetBank = num(p, ['amber_last_known_gross_bank_unmapped']);
    const actual = p.amber_actual_cash == null ? null : Number(p.amber_actual_cash);
    const ar = num(p, ['ar_open_invoices']);
    const ap = num(p, ['ap_open_bills', 'ap_total']);
    const control = num(p, ['ap_control_balance']);
    let html = '<div class="sec-sub">Exact figures for Dan’s Tuesday and Friday decisions. Cash is shown twice when the sources disagree. One number is not blended from the other.</div>';
    html += sourceLine(snap);
    html += '<div class="fin-grid">';
    html += card(book === null ? 'Pending' : book, 'Cash — QuickBooks book', 'qbo', 'QuickBooks book', '');
    html += card(actual == null || !Number.isFinite(actual) ? 'Pending' : actual, 'Cash — Amber confirmed', 'wait', 'Unconfirmed', '');
    html += card(sheetBank === null ? 'Pending' : sheetBank, 'Cash — Amber sheet, unconfirmed', 'amber', 'Amber sheet ' + (p.amber_source_date || ''), '');
    html += card(ar === null ? 'Pending' : ar, 'Open AR', 'qbo', 'QuickBooks book', p.ar_invoice_count ? esc(p.ar_invoice_count + ' open invoices. Amber confirmation is still open.') : 'Amber confirmation is still open.');
    html += card(ap === null ? 'Pending' : ap, 'Open AP', 'qbo', 'QuickBooks book', p.ap_bill_count ? esc(p.ap_bill_count + ' open bills.') : '');
    html += '</div>';
    if (p.ar_buckets) {
      const b = p.ar_buckets;
      html += '<div class="sec-sub">' + esc(p.ar_basis || 'AR buckets from the snapshot. Due-date aging, separate from AP bill-date aging.') + '</div>';
      html += table(['AR bucket', 'Amount', 'Source'], [
        row2('Not due / due today', b.not_due_or_due_today),
        row2('1–30 overdue', b.d1_30),
        row2('31–45 overdue', b.d31_45),
        row2('46–60 overdue', b.d46_60),
        row2('61+ overdue', b.d61_plus)
      ].join(''));
    }
    if (Array.isArray(p.ar_61_plus_detail) && p.ar_61_plus_detail.length) {
      html += '<div class="sec-sub" style="margin-top:12px">61+ AR named on the snapshot</div>';
      html += table(['Name', 'Amount', 'Source'], p.ar_61_plus_detail.map(function (r) {
        return '<tr><td class="kpi-name">' + esc(r.name) + '</td><td>' + money(r.amount) + '</td><td>QuickBooks book · unconfirmed</td></tr>';
      }).join(''));
    }
    if (control !== null && ap !== null) {
      html += '<div class="fin-note" style="margin-top:14px">A/P control ' + money(control) + ' · open bills ' + money(ap) + ' · difference ' + money((cents(ap) - cents(control)) / 100) + '. ' + esc(p.ap_control_note || '') + '</div>';
    }
    return html;
  }
  function row2(label, amount) {
    return '<tr><td class="kpi-name">' + esc(label) + '</td><td>' + money(amount) + '</td><td>QuickBooks book · unconfirmed</td></tr>';
  }

  function billsOf(snap) {
    return ((snap && snap.payload && snap.payload.bills) || []).map(function (b) {
      return {
        bill_id: b.bill_id || '',
        vendor: b.vendor || '',
        bill_date: b.bill_date || '',
        open_balance: Number(b.open_balance),
        age_days: Number(b.age_days),
        bucket: b.bucket || bucketOf(Number(b.age_days))
      };
    });
  }
  function bucketOf(age) {
    if (age <= 30) return 'current_0_30';
    if (age <= 45) return '31_45';
    if (age <= 60) return '46_60';
    return '60_plus';
  }
  function bucketTotals(bills) {
    const t = { current_0_30: 0, '31_45': 0, '46_60': 0, '60_plus': 0 };
    bills.forEach(function (b) {
      const key = bucketOf(b.age_days);
      t[key] = (cents(t[key]) + cents(b.open_balance)) / 100;
    });
    return t;
  }
  function statedAging(p) {
    if (p.ap_aging) {
      return {
        current_0_30: p.ap_aging.current_including_future,
        '31_45': p.ap_aging['31_45'],
        '46_60': p.ap_aging['46_60'],
        '60_plus': p.ap_aging['61_plus']
      };
    }
    if (p.aging) {
      return {
        current_0_30: p.aging.current,
        '31_45': p.aging.d31_45,
        '46_60': p.aging.d46_60,
        '60_plus': p.aging.d60_plus
      };
    }
    return null;
  }

  function renderAging() {
    const snap = billSnap() || newest(function (p) { return !!(p.ap_aging || p.aging); });
    if (!snap) return empty('No AP aging snapshot is in the log yet. Pending Amber.');
    const p = snap.payload || {};
    const bills = billsOf(snap);
    const stated = statedAging(p);
    let html = '<div class="sec-sub">Buckets are days since the bill date. Current is 0–30 and includes future-dated bills. 60+ is the snapshot’s 61+ bucket.</div>';
    html += sourceLine(snap);
    if (p.ap_aging_basis) html += '<div class="sec-sub">' + esc(p.ap_aging_basis) + '</div>';
    if (stated) {
      html += '<div class="fin-grid">';
      html += card(Number(stated.current_0_30), 'Current 0–30', 'qbo', 'QuickBooks book', 'Includes future-dated bills.');
      html += card(Number(stated['31_45']), '31–45', 'qbo', 'QuickBooks book', '');
      html += card(Number(stated['46_60']), '46–60', 'qbo', 'QuickBooks book', '');
      html += card(Number(stated['60_plus']), '60+', 'qbo', 'QuickBooks book', 'Age 61 and over.');
      html += '</div>';
    }
    if (!bills.length) {
      html += pendingBox('Vendor lines are not in this snapshot. The bucket totals above are all the log has. Pending Amber for a vendor breakdown.');
      return html;
    }
    const grouped = {};
    bills.forEach(function (b) {
      if (!grouped[b.vendor]) grouped[b.vendor] = { current_0_30: 0, '31_45': 0, '46_60': 0, '60_plus': 0 };
      const key = bucketOf(b.age_days);
      grouped[b.vendor][key] = (cents(grouped[b.vendor][key]) + cents(b.open_balance)) / 100;
    });
    const names = Object.keys(grouped).sort(function (a, b) { return a.localeCompare(b); });
    const body = names.map(function (name) {
      const g = grouped[name];
      const total = (cents(g.current_0_30) + cents(g['31_45']) + cents(g['46_60']) + cents(g['60_plus'])) / 100;
      return '<tr><td class="kpi-name">' + esc(name) + '</td><td>' + money(g.current_0_30) + '</td><td>' + money(g['31_45']) + '</td><td>' + money(g['46_60']) + '</td><td>' + money(g['60_plus']) + '</td><td>' + money(total) + '</td></tr>';
    }).join('');
    const sums = bucketTotals(bills);
    const sumTotal = (cents(sums.current_0_30) + cents(sums['31_45']) + cents(sums['46_60']) + cents(sums['60_plus'])) / 100;
    html += table(['Vendor', 'Current 0–30', '31–45', '46–60', '60+', 'Total'], body +
      '<tr><td class="kpi-name">Line total</td><td>' + money(sums.current_0_30) + '</td><td>' + money(sums['31_45']) + '</td><td>' + money(sums['46_60']) + '</td><td>' + money(sums['60_plus']) + '</td><td>' + money(sumTotal) + '</td></tr>');
    html += '<div class="sec-sub">Line total ' + money(sumTotal) + (p.ap_open_bills != null ? ' · stated open AP ' + money(p.ap_open_bills) : '') + '.</div>';
    html += '<div class="sec-sub" style="margin-top:8px">Open bills in this snapshot</div>';
    html += table(['Bill', 'Vendor', 'Bill date', 'Age', 'Bucket', 'Open balance'], bills.map(function (b) {
      return '<tr><td>' + esc(b.bill_id) + '</td><td class="kpi-name">' + esc(b.vendor) + '</td><td>' + esc(fmtDay(b.bill_date)) + '</td><td>' + esc(b.age_days) + '</td><td>' + esc(b.bucket) + '</td><td>' + money(b.open_balance) + '</td></tr>';
    }).join(''));
    return html;
  }

  function renderRed() {
    const snap = redSnap();
    if (!snap) return empty('No red-vendor list is in the latest snapshots. Pending Amber. Proposed pay dates stay blank until Dan saves one here.');
    const p = snap.payload || {};
    const rows = p.red_vendors || [];
    let html = '<div class="sec-sub">Vendors past 45 days from the bill date. Amount is the past-45 portion. Proposed pay date starts blank for Dan. Saving a date does not pay the vendor.</div>';
    html += sourceLine(snap);
    if (p.ap_past45 != null) html += '<div class="sec-sub">Stated past-45 total ' + money(p.ap_past45) + '.</div>';
    const body = rows.map(function (r, idx) {
      const pay = latestEntry('portal_pay_date', r.vendor, 'proposed_pay_date');
      const contact = latestEntry('portal_contact', r.vendor, 'note');
      const contactText = contact ? fmtWhen(contact.row.logged_at) + (contact.row.payload.who ? ' · ' + contact.row.payload.who : '') : '—';
      const payShown = pay ? esc(pay.value) : '—';
      return '<tr><td class="kpi-name">' + esc(r.vendor) + '</td><td>' + money(r.past_45) + '</td><td>' + esc(r.oldest_bill ? fmtDay(r.oldest_bill) : '—') + '</td><td>' + esc(contactText) + '</td><td>' + payShown + '</td><td><input class="actual-inp" type="date" data-pay-input="' + idx + '" aria-label="Proposed pay date for ' + esc(r.vendor) + '"><button type="button" class="tbtn" data-act="save-pay" data-idx="' + idx + '" style="margin-left:6px">Save date</button></td></tr>';
    }).join('');
    html += table(['Vendor', 'Past-45 amount', 'Oldest bill', 'Last contact', 'Proposed pay date', 'Dan’s date'], body);
    html += '<div class="sec-sub">Save date writes a new note on this desk. It does not create a payment.</div>';
    return html;
  }

  function renderDue() {
    const snap = newest(function (p) {
      return p.due_next_14d || (Array.isArray(p.future_dated_bills_next_14d) && p.future_dated_bills_next_14d.length) || (Array.isArray(p.bills) && p.bills.length);
    });
    if (!snap) return empty('No 14-day bill snapshot is in the log yet. Pending Amber.');
    const p = snap.payload || {};
    let html = sourceLine(snap);
    if (p.due_next_14d && typeof p.due_next_14d === 'object') {
      const d = p.due_next_14d;
      html += '<div class="fin-grid">';
      html += card(Number(d.amount), 'Bills in the recorded 14-day window', 'qbo', 'Snapshot total', esc((d.from || '') + ' to ' + (d.to || '')));
      html += card(d.cash_left_after == null ? 'Pending' : Number(d.cash_left_after), 'Cash left after that window', 'qbo', 'From the same snapshot', 'Uses the cash figure stored with that snapshot.');
      html += '</div>';
    } else {
      html += pendingBox('Due dates are not in this snapshot. The full total of bills due in the next 14 days, and cash left after that full total, is pending Amber. The rows below are only open bills whose bill date falls in the next 14 days.');
    }
    const future = Array.isArray(p.future_dated_bills_next_14d) ? p.future_dated_bills_next_14d : [];
    if (!future.length) {
      html += '<div class="sec-sub">No future-dated bills were listed on this snapshot.</div>';
      return html;
    }
    const windowText = p.future_dated_window ? (p.future_dated_window.from + ' through ' + p.future_dated_window.to) : 'the next 14 days';
    const sumCents = future.reduce(function (acc, b) { return acc + cents(b.open_balance); }, 0);
    const book = bookCash(p);
    const left = book === null ? null : (cents(book) - sumCents) / 100;
    html += '<div class="sec-sub">Future-dated open bills with a bill date in ' + esc(windowText) + '. These are not every bill that comes due in 14 days.</div>';
    html += table(['Bill', 'Vendor', 'Bill date', 'Open balance', 'Source'], future.map(function (b) {
      return '<tr><td>' + esc(b.bill_id || '') + '</td><td class="kpi-name">' + esc(b.vendor) + '</td><td>' + esc(fmtDay(b.bill_date)) + '</td><td>' + money(b.open_balance) + '</td><td>QuickBooks book</td></tr>';
    }).join(''));
    html += '<div class="fin-grid" style="margin-top:14px">';
    html += card(sumCents / 100, 'Sum of these future-dated bills', 'qbo', 'QuickBooks book', '');
    html += card(book === null ? 'Pending' : book, 'QuickBooks book cash', 'qbo', 'QuickBooks book', '');
    html += card(left === null ? 'Pending' : left, 'Book cash after these bills only', 'qbo', 'QuickBooks book', 'Book cash minus the rows above. Not cash left after all bills due in 14 days.');
    html += '</div>';
    return html;
  }

  function duplicateGroups(bills) {
    const map = {};
    bills.forEach(function (b) {
      const key = [b.vendor, b.bill_date, Number(b.open_balance).toFixed(2)].join('|');
      if (!map[key]) map[key] = [];
      map[key].push(b);
    });
    return Object.keys(map).map(function (k) { return map[k]; }).filter(function (g) { return g.length > 1; });
  }

  function renderAutopay() {
    const snap = newest(function (p) { return typeof p.autopay === 'string' || (Array.isArray(p.bills) && p.bills.length); });
    if (!snap) return empty('No autopay or duplicate-bill snapshot is in the log yet. Pending Amber.');
    const p = snap.payload || {};
    const bills = billsOf(billSnap() || snap);
    let html = sourceLine(snap);
    html += '<div class="fin-note">' + esc(p.autopay || 'Autopay status is not in this snapshot. Pending Amber.') + '</div>';
    const groups = duplicateGroups(bills);
    if (!bills.length) {
      html += pendingBox('Open bill lines are not on this snapshot, so a duplicate check cannot be run.');
    } else if (!groups.length) {
      html += '<div class="sec-sub">Duplicate check: no two open bills share the same vendor, bill date, and amount.</div>';
    } else {
      html += '<div class="sec-sub">Possible duplicates: same vendor, same bill date, and same open amount, with different bill ids. Review before anyone treats them as one bill.</div>';
      html += table(['Bill', 'Vendor', 'Bill date', 'Open balance'], groups.map(function (g) {
        return g.map(function (b) {
          return '<tr><td>' + esc(b.bill_id) + '</td><td class="kpi-name">' + esc(b.vendor) + '</td><td>' + esc(fmtDay(b.bill_date)) + '</td><td>' + money(b.open_balance) + '</td></tr>';
        }).join('');
      }).join(''));
    }
    const notes = entries('portal_autopay_note');
    html += '<div class="sec-sub" style="margin-top:12px">Notes saved on this desk</div>';
    html += notes.length ? table(['When', 'Note'], notes.map(function (s) {
      return '<tr><td>' + esc(fmtWhen(s.logged_at)) + '</td><td>' + esc((s.payload && s.payload.note) || '') + '</td></tr>';
    }).join('')) : '<div class="sec-sub">No autopay note has been saved.</div>';
    html += '<div class="fin-form"><label class="sec-sub" style="margin:0">Add a review note</label><textarea id="fin-autopay-note" placeholder="What Amber checked. This note is not a payment."></textarea><div><button type="button" class="tbtn green" data-act="save-autopay">Save note</button></div></div>';
    return html;
  }

  function renderContacts() {
    const rows = entries('portal_contact');
    let html = '<div class="sec-sub">Vendor contact log for Driven Solutions. Saving adds a note. It does not email the vendor.</div>';
    html += rows.length ? table(['When', 'Vendor', 'Who', 'Contact date', 'Note'], rows.map(function (s) {
      const p = s.payload || {};
      return '<tr><td>' + esc(fmtWhen(s.logged_at)) + '</td><td class="kpi-name">' + esc(p.vendor || '') + '</td><td>' + esc(p.who || '—') + '</td><td>' + esc(p.contact_date ? fmtDay(p.contact_date) : '—') + '</td><td>' + esc(p.note || '') + '</td></tr>';
    }).join('')) : pendingBox('No vendor contacts are logged yet.');
    const vendors = vendorOptions();
    html += '<div class="fin-form"><label class="sec-sub" style="margin:0">Vendor</label><input class="actual-inp" id="fin-contact-vendor" list="fin-vendor-list" style="width:100%;max-width:360px"><datalist id="fin-vendor-list">' + vendors + '</datalist><label class="sec-sub" style="margin:0">Who spoke</label><input class="actual-inp" id="fin-contact-who" style="width:100%;max-width:360px"><label class="sec-sub" style="margin:0">Contact date</label><input class="actual-inp" id="fin-contact-when" type="date"><label class="sec-sub" style="margin:0">Note</label><textarea id="fin-contact-note"></textarea><div><button type="button" class="tbtn green" data-act="save-contact">Save contact</button></div></div>';
    return html;
  }

  function vendorOptions() {
    const snap = redSnap();
    const names = ((snap && snap.payload && snap.payload.red_vendors) || []).map(function (r) { return r.vendor; });
    return names.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('');
  }

  function renderDrafts() {
    const rows = entries('portal_draft');
    let html = '<div class="fin-note">Drafts stay on this page for review. This desk has no send control and does not email anyone.</div>';
    html += rows.length ? table(['Saved', 'Vendor', 'To', 'Subject', 'Status'], rows.map(function (s, idx) {
      const p = s.payload || {};
      return '<tr><td>' + esc(fmtWhen(s.logged_at)) + '</td><td class="kpi-name">' + esc(p.vendor || '') + '</td><td>' + esc(p.to || '—') + '</td><td>' + esc(p.subject || '') + '</td><td>DRAFT <button type="button" class="tbtn" data-act="copy-draft" data-idx="' + idx + '">Copy text</button></td></tr>' +
        '<tr><td colspan="5" style="white-space:pre-wrap;font-family:Barlow,sans-serif">' + esc(p.body || '') + '</td></tr>';
    }).join('')) : pendingBox('No drafts yet.');
    const snap = redSnap();
    const options = '<option value="">Select a red-list vendor</option>' + ((snap && snap.payload && snap.payload.red_vendors) || []).map(function (r) {
      return '<option value="' + esc(r.vendor) + '">' + esc(r.vendor) + '</option>';
    }).join('');
    html += '<div class="fin-form"><label class="sec-sub" style="margin:0">Red-list vendor</label><select class="actual-inp" id="fin-draft-vendor" style="width:100%;max-width:360px">' + options + '</select><label class="sec-sub" style="margin:0">To (stored on the draft, not used to send)</label><input class="actual-inp" id="fin-draft-to" style="width:100%;max-width:360px" autocomplete="off"><label class="sec-sub" style="margin:0">Subject</label><input class="actual-inp" id="fin-draft-subject" style="width:100%"><label class="sec-sub" style="margin:0">Body</label><textarea id="fin-draft-body"></textarea><div><button type="button" class="tbtn" data-act="fill-draft">Fill from red list</button> <button type="button" class="tbtn green" data-act="save-draft">Save draft</button></div><div class="sec-sub">Save draft keeps the text here. It does not send email.</div></div>';
    return html;
  }

  function render() {
    if (drawing) return;
    const focused = document.activeElement;
    const panel = document.getElementById('panel-findesk');
    if (focused && panel && panel.contains(focused) && focused.matches('input,textarea,select')) return;
    drawing = true;
    const views = {
      cash: renderCash,
      decisions: renderDecisions,
      aging: renderAging,
      red: renderRed,
      due: renderDue,
      autopay: renderAutopay,
      contacts: renderContacts,
      drafts: renderDrafts
    };
    Object.keys(views).forEach(function (name) {
      const el = document.getElementById('fin-view-' + name);
      if (el) el.innerHTML = views[name]();
      const btn = document.querySelector('[data-fin-view="' + name + '"]');
      if (btn) btn.classList.toggle('active', name === view);
      if (el) el.classList.toggle('active', name === view);
    });
    drawing = false;
  }

  function setStatus(html) {
    const el = document.getElementById('fin-status');
    if (el) el.innerHTML = html;
  }

  async function load() {
    const client = db();
    if (!client) {
      setStatus('Finance Desk is waiting for the Command Center connection.');
      return;
    }
    const res = await client.rpc('fin_portal_read');
    if (res.error) {
      snaps = [];
      setStatus('The desk cannot read snapshots yet. Run sql/fin_portal_read.sql in Supabase. No stand-in figures are shown.');
      render();
      return;
    }
    snaps = (res.data && res.data.snapshots) || [];
    const top = sources()[0];
    if (!top) {
      setStatus('No finance snapshot is in the log. Pending Amber.');
    } else {
      const p = top.payload || {};
      setStatus('Latest source snapshot as of ' + esc(fmtWhen(asOf(top))) + '. ' + chip('qbo', 'QuickBooks book') + ' ' + chip('amber', 'Amber sheet') + ' ' + chip('wait', p.confirmation_status || 'Unconfirmed') + ' Header cash on hand is the weekly KPI and is a different figure.');
    }
    render();
    if (!timer) timer = setInterval(load, 60000);
  }

  async function append(action, payload) {
    const client = db();
    if (!client) throw new Error('Not connected');
    const res = await client.rpc('fin_portal_append', { p_action: action, p_payload: payload });
    if (res.error) throw new Error(res.error.message || 'Save failed');
    if (res.data && res.data.email_sent) throw new Error('Refusing to keep a note marked as sent.');
    return res.data;
  }

  function toastMsg(msg, kind) {
    if (typeof toast === 'function') toast(msg, kind);
  }

  async function onClick(ev) {
    const tab = ev.target.closest('[data-fin-view]');
    if (tab) {
      view = tab.getAttribute('data-fin-view');
      render();
      return;
    }
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    try {
      if (act === 'save-pay') {
        const idx = Number(btn.getAttribute('data-idx'));
        const snap = redSnap();
        const vendor = snap && snap.payload.red_vendors[idx] && snap.payload.red_vendors[idx].vendor;
        const input = document.querySelector('[data-pay-input="' + idx + '"]');
        const date = input && input.value;
        if (!vendor || !date) { toastMsg('Enter a proposed pay date first.', 'err'); return; }
        await append('portal_pay_date', { vendor: vendor, proposed_pay_date: date, email_sent: false });
        toastMsg('Proposed date saved. No payment was made.', 'ok');
      } else if (act === 'save-contact') {
        const vendor = document.getElementById('fin-contact-vendor').value.trim();
        const note = document.getElementById('fin-contact-note').value.trim();
        if (!vendor || !note) { toastMsg('Vendor and note are required.', 'err'); return; }
        await append('portal_contact', {
          vendor: vendor,
          who: document.getElementById('fin-contact-who').value.trim(),
          contact_date: document.getElementById('fin-contact-when').value || null,
          note: note
        });
        toastMsg('Contact saved. No email was sent.', 'ok');
      } else if (act === 'save-draft') {
        const vendor = document.getElementById('fin-draft-vendor').value.trim();
        const subject = document.getElementById('fin-draft-subject').value.trim();
        const body = document.getElementById('fin-draft-body').value.trim();
        if (!vendor || !subject || !body) { toastMsg('Vendor, subject, and body are required.', 'err'); return; }
        await append('portal_draft', {
          vendor: vendor,
          to: document.getElementById('fin-draft-to').value.trim(),
          subject: subject,
          body: body,
          status: 'draft'
        });
        toastMsg('Draft saved on this page. It was not emailed.', 'ok');
      } else if (act === 'fill-draft') {
        fillDraft();
        return;
      } else if (act === 'copy-draft') {
        const idx = Number(btn.getAttribute('data-idx'));
        const row = entries('portal_draft')[idx];
        const p = (row && row.payload) || {};
        const text = (p.subject ? 'Subject: ' + p.subject + '\n\n' : '') + (p.body || '');
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
        toastMsg('Draft text copied. It was not emailed.', 'ok');
        return;
      } else if (act === 'save-autopay') {
        const note = document.getElementById('fin-autopay-note').value.trim();
        if (!note) { toastMsg('Write the note first.', 'err'); return; }
        await append('portal_autopay_note', { note: note });
        toastMsg('Note saved.', 'ok');
      } else return;
      await load();
    } catch (err) {
      toastMsg(err.message || 'Save failed', 'err');
    }
  }

  function fillDraft() {
    const select = document.getElementById('fin-draft-vendor');
    const vendor = select ? select.value : '';
    if (!vendor) { toastMsg('Choose a red-list vendor first.', 'err'); return; }
    const snap = redSnap();
    const row = ((snap && snap.payload && snap.payload.red_vendors) || []).find(function (r) { return r.vendor === vendor; });
    const amount = row ? money(row.past_45) : 'the past-45 balance on this desk';
    const oldest = row && row.oldest_bill ? fmtDay(row.oldest_bill) : 'the oldest bill on this desk';
    document.getElementById('fin-draft-subject').value = 'Driven Solutions — open balance for ' + vendor;
    document.getElementById('fin-draft-body').value =
      'Hello,\n\nThis is Amber at Driven Solutions. We are reviewing the open balance past 45 days (' + amount + ', oldest bill ' + oldest + '). A pay date is not set on this draft.\n\nThis is a draft for review. It has not been sent.\n';
  }

  const panel = document.getElementById('panel-findesk');
  if (panel) panel.addEventListener('click', onClick);

  window.finDeskLoad = load;
  window.finDeskPause = function () {
    if (timer) clearInterval(timer);
    timer = null;
  };
})();
