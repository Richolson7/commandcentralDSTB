/* Driven Finance Desk
   Reads fin_portal_read() only. Does not write dashboard_data, fin_config,
   or fin_weekly_log. Appends notes with fin_portal_append (insert only).
   Never sends email and never pays a bill. */
(function () {
  const SOURCE_ACTIONS = new Set(['portal_source_snapshot', 'bot_daily_cash_snapshot', 'bot_ap_snapshot']);
  let snaps = [];
  let view = 'overview';
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
  function empty(title) {
    return '<div class="fin-note">' + esc(title) + '</div>';
  }
  function pendingBox(text) {
    return '<div class="fin-note">' + text + '</div>';
  }
  function badge(st, text) {
    return '<span class="status-chip ' + st + '">' + esc(text) + '</span>';
  }
  function section(title, inner) {
    return '<div class="fin-block"><div class="kpi-sec-hdr"><div class="kpi-sec-name">' + esc(title) + '</div></div><div style="margin-top:10px">' + inner + '</div></div>';
  }
  function tile(value, label, tone) {
    const numeric = typeof value === 'number' && Number.isFinite(value);
    let text = 'Pending';
    let numCls = ' na';
    let cardCls = '';
    if (numeric) {
      text = money(value);
      numCls = value < 0 ? ' breach' : (tone === 'warn' ? ' warn' : '');
      cardCls = value < 0 ? ' red' : (tone === 'warn' ? ' amber' : '');
    } else if (tone === 'warn') {
      cardCls = ' amber';
    }
    return '<div class="sum-card' + cardCls + '"><div class="sum-num' + numCls + '">' + text + '</div><div class="sum-lbl">' + esc(label) + '</div></div>';
  }
  function tiles(html) {
    return '<div class="summary-grid">' + html + '</div>';
  }
  function vendorCard(name, amount, tone, body) {
    const hasAmt = !(amount == null || amount === '');
    const shown = typeof amount === 'number' && Number.isFinite(amount) ? money(amount) : esc(amount == null ? 'Pending' : String(amount));
    const cls = tone === 'bad' || (typeof amount === 'number' && amount < 0) ? ' bad' : tone === 'warn' ? ' warn' : tone === 'mute' ? ' mute' : '';
    const amt = hasAmt ? '<div class="fin-item-amt' + cls + '">' + shown + '</div>' : '';
    return '<article class="fin-item"><div class="fin-item-top"><div class="fin-item-name">' + esc(name) + '</div>' + amt + '</div>' + (body || '') + '</article>';
  }
  function list(html) {
    return '<div class="fin-list">' + html + '</div>';
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

  function dayOf(snap) {
    const p = (snap && snap.payload) || {};
    if (p.report_date) return String(p.report_date).slice(0, 10);
    if (p.qbo_as_of_central) return String(p.qbo_as_of_central).slice(0, 10);
    if (snap && snap.logged_at) return String(snap.logged_at).slice(0, 10);
    return '';
  }
  function priorBook(current) {
    const cur = dayOf(current);
    const rows = sources();
    for (let i = 0; i < rows.length; i++) {
      if (current && rows[i].id === current.id) continue;
      const day = dayOf(rows[i]);
      if (cur && day && day >= cur) continue;
      const b = bookCash(rows[i].payload || {});
      if (b === null) continue;
      return { snap: rows[i], book: b, day: day };
    }
    return null;
  }
  function billsOf(snap) {
    return ((snap && snap.payload && snap.payload.bills) || []).map(function (b) {
      return {
        bill_id: b.bill_id || '',
        vendor: b.vendor || '',
        bill_date: b.bill_date || '',
        open_balance: Number(b.open_balance),
        age_days: Number(b.age_days)
      };
    });
  }
  function bucketOf(age) {
    if (age <= 30) return 'current_0_30';
    if (age <= 45) return '31_45';
    if (age <= 60) return '46_60';
    return '60_plus';
  }
  function bucketLabel(key) {
    return { current_0_30: 'Current 0–30', '31_45': '31–45', '46_60': '46–60', '60_plus': '60+' }[key] || key;
  }
  function bucketChip(key) {
    if (key === '31_45') return 'st-a';
    if (key === '46_60' || key === '60_plus') return 'st-r';
    return 'st-n';
  }
  function statedAging(p) {
    if (!p) return null;
    if (p.ap_aging) {
      return {
        current_0_30: Number(p.ap_aging.current_including_future),
        '31_45': Number(p.ap_aging['31_45']),
        '46_60': Number(p.ap_aging['46_60']),
        '60_plus': Number(p.ap_aging['61_plus'])
      };
    }
    if (p.aging) {
      return {
        current_0_30: Number(p.aging.current),
        '31_45': Number(p.aging.d31_45),
        '46_60': Number(p.aging.d46_60),
        '60_plus': Number(p.aging.d60_plus)
      };
    }
    return null;
  }
  function vendorGroups(bills) {
    const grouped = {};
    bills.forEach(function (b) {
      if (!grouped[b.vendor]) grouped[b.vendor] = { name: b.vendor, bills: [], current_0_30: 0, '31_45': 0, '46_60': 0, '60_plus': 0 };
      const key = bucketOf(b.age_days);
      grouped[b.vendor][key] = (cents(grouped[b.vendor][key]) + cents(b.open_balance)) / 100;
      grouped[b.vendor].bills.push(b);
    });
    return Object.keys(grouped).map(function (name) {
      const g = grouped[name];
      g.total = (cents(g.current_0_30) + cents(g['31_45']) + cents(g['46_60']) + cents(g['60_plus'])) / 100;
      g.bills.sort(function (a, b) { return b.age_days - a.age_days; });
      return g;
    }).sort(function (a, b) { return b.total - a.total; });
  }
  function pack() {
    const cash = cashSnap();
    const dec = decisionSnap() || cash;
    const bill = billSnap();
    const red = redSnap();
    const pc = (cash && cash.payload) || {};
    const pd = (dec && dec.payload) || {};
    const pb = (bill && bill.payload) || {};
    const pr = (red && red.payload) || {};
    const book = bookCash(pc) != null ? bookCash(pc) : bookCash(pd);
    const sheet = num(pc, ['amber_last_known_gross_bank_unmapped']);
    const future = Array.isArray(pb.future_dated_bills_next_14d) ? pb.future_dated_bills_next_14d : [];
    const futureCents = future.reduce(function (acc, b) { return acc + cents(b.open_balance || 0); }, 0);
    return {
      cash: cash, dec: dec, bill: bill, red: red, pc: pc, pd: pd, pb: pb, pr: pr,
      book: book,
      deposit: depositCash(pc),
      undeposited: num(pc, ['undeposited_funds_separate']),
      sheet: sheet,
      actual: pc.amber_actual_cash == null || pc.amber_actual_cash === '' ? null : Number(pc.amber_actual_cash),
      available: num(pc, ['amber_available_to_use', 'amber_available_cash']),
      formula: num(pc, ['amber_last_known_reserve_adjusted_formula']),
      reserve: num(pc, ['amber_outflow_reserve']),
      gap: (sheet != null && book != null) ? (cents(sheet) - cents(book)) / 100 : null,
      ar: num(pd, ['ar_open_invoices']),
      ap: num(pd, ['ap_open_bills', 'ap_total']),
      past: pr.ap_past45 != null ? Number(pr.ap_past45) : num(pd, ['ap_past45']),
      reds: pr.red_vendors || [],
      aging: statedAging(pb.ap_aging || pb.aging ? pb : pd),
      lines: billsOf(bill),
      future: future,
      futureSum: future.length ? futureCents / 100 : null,
      left: (book != null && future.length) ? (cents(book) - futureCents) / 100 : null
    };
  }
  function rhythm() {
    return '<div class="fin-badges">' +
      badge('st-n', 'Tue / Fri snapshots') + badge('st-n', 'Weekly Dan + Rich') +
      badge('st-n', 'Monthly strategy') + badge('st-n', 'Quarterly review') +
      '</div><div class="sec-sub">Those agendas use the Tuesday and Friday snapshots of cash, AR, AP, and upcoming obligations. They do not use a different reporting clock. Cutoff time: not set on this desk. Dan asked for a clear cutoff on November 6.</div>';
  }
  function scoreLegend(f) {
    return '<div class="fin-badges">' +
      badge('st-r', 'Red · book cash is negative') +
      badge('st-a', 'Yellow · Amber has not confirmed') +
      badge('st-n', 'Green · no on-target score is on file') +
      '</div><div class="sec-sub">Green, yellow, and red here mark this snapshot only. Employee productivity has no score on file.</div>';
  }
  function cashTiles(f) {
    return tiles(
      tile(f.book, 'QuickBooks book cash') +
      tile(f.actual, 'Amber confirmed bank', 'warn') +
      tile(f.sheet, 'Amber sheet bank', 'warn') +
      tile(f.gap, 'Sheet minus book', 'warn')
    );
  }
  function coreTiles(f) {
    return tiles(
      tile(f.book, 'Book cash') +
      tile(f.sheet, 'Amber sheet bank', 'warn') +
      tile(f.ar, 'Open AR') +
      tile(f.ap, 'Open AP') +
      tile(f.past, 'AP past 45 days')
    );
  }
  function accountList(f) {
    const accounts = (f.pc.qbo_accounts || []).slice();
    let html = '';
    if (!accounts.length && f.book != null) accounts.push({ name: 'QuickBooks book cash', balance: f.book });
    accounts.forEach(function (a) {
      html += vendorCard(a.name, Number(a.balance), '', '<div class="fin-item-meta">QuickBooks book. Not a bank-available balance.</div>');
    });
    if (f.deposit != null && !accounts.some(function (a) { return /deposit/i.test(a.name || ''); })) {
      html += vendorCard('Cash to deposit', f.deposit, '', '<div class="fin-item-meta">QuickBooks book.</div>');
    }
    html += vendorCard('Undeposited funds', f.undeposited == null ? 'Pending' : f.undeposited, 'warn', '<div class="fin-item-meta">' + esc(f.pc.undeposited_funds_note || 'Not bank cash.') + '</div>');
    html += vendorCard('Amber sheet bank', f.sheet == null ? 'Pending' : f.sheet, 'warn', '<div class="fin-item-meta">Sheet date ' + esc(f.pc.amber_source_date || 'not stated') + '. ' + esc(f.pc.amber_gross_bank_note || 'Unconfirmed. Not the QuickBooks book balance.') + '</div>');
    html += vendorCard('Amber confirmed bank', f.actual == null ? 'Pending' : f.actual, 'mute', '<div class="fin-item-meta">Amber has not confirmed an actual bank balance on this snapshot.</div>');
    html += vendorCard('Available to use', f.available == null ? 'Pending' : f.available, 'warn', '<div class="fin-item-meta">' + esc(f.pc.amber_available_note || 'Sheet formula. Not raw bank cash.') + '</div>');
    html += vendorCard('Actual in Bank formula', f.formula == null ? 'Pending' : f.formula, 'warn', '<div class="fin-item-meta">' + esc(f.pc.amber_reserve_adjusted_note || 'Reserve-adjusted formula. Not raw bank cash.') + '</div>');
    if (f.reserve != null) html += vendorCard('Outflow reserve on the sheet', f.reserve, 'warn', '<div class="fin-item-meta">' + esc(f.pc.amber_outflow_reserve_note || 'Not a bank balance.') + '</div>');
    if (f.pc.amber_old_holding_checks != null || f.pc.amber_mailed_not_cashed != null) {
      html += vendorCard('Old holding checks', f.pc.amber_old_holding_checks == null ? 'Pending' : Number(f.pc.amber_old_holding_checks), 'warn', '<div class="fin-item-meta">Mailed and not cashed ' + money(f.pc.amber_mailed_not_cashed) + '. ' + esc(f.pc.amber_holding_note || 'Unconfirmed. Not treated as bank cash.') + '</div>');
    }
    const prev = priorBook(f.cash || f.dec);
    if (prev) {
      html += vendorCard('Previous book snapshot', prev.book, '', '<div class="fin-item-meta">Dated ' + esc(fmtDay(prev.day)) + '. This is the earlier QuickBooks book figure on file. A last-week close by account is not on file.</div>');
    } else {
      html += vendorCard('Previous book snapshot', 'Not on file', 'mute', '<div class="fin-item-meta">No earlier book snapshot is in the log.</div>');
    }
    return list(html);
  }
  function agingCards(f) {
    const groups = vendorGroups(f.lines);
    if (!groups.length) return pendingBox('Vendor lines are not in this snapshot. Pending Amber.');
    return list(groups.map(function (g) {
      const chips = ['current_0_30', '31_45', '46_60', '60_plus'].map(function (key) {
        return badge(bucketChip(key), bucketLabel(key) + ' ' + money(g[key]));
      }).join('');
      const bills = g.bills.map(function (b) {
        return '<div class="fin-subitem"><span>Bill ' + esc(b.bill_id) + ' · ' + esc(fmtDay(b.bill_date)) + ' · ' + esc(b.age_days) + ' days</span><span>' + badge(bucketChip(bucketOf(b.age_days)), bucketLabel(bucketOf(b.age_days))) + ' ' + money(b.open_balance) + '</span></div>';
      }).join('');
      const tone = (g['46_60'] > 0 || g['60_plus'] > 0) ? 'bad' : (g['31_45'] > 0 ? 'warn' : '');
      return vendorCard(g.name, g.total, tone, '<div class="fin-badges">' + chips + '</div>' + bills);
    }).join(''));
  }
  function redCards(f) {
    if (!f.reds.length) return empty('No red-vendor list is in the latest snapshots. Pending Amber.');
    return list(f.reds.map(function (r, idx) {
      const pay = latestEntry('portal_pay_date', r.vendor, 'proposed_pay_date');
      const contact = latestEntry('portal_contact', r.vendor, 'note');
      const contactText = contact ? fmtWhen(contact.row.logged_at) + (contact.row.payload.who ? ' · ' + contact.row.payload.who : '') : 'Not logged';
      return vendorCard(r.vendor, Number(r.past_45), 'bad',
        '<div class="fin-badges">' + badge('st-r', 'Past 45 days') + '</div>' +
        '<div class="fin-item-meta">Oldest bill ' + esc(r.oldest_bill ? fmtDay(r.oldest_bill) : 'not on file') + '</div>' +
        '<div class="fin-item-meta">Last contact ' + esc(contactText) + '</div>' +
        '<div class="fin-item-meta">Proposed pay date ' + esc(pay ? pay.value : 'blank') + '</div>' +
        '<div class="fin-form"><input class="actual-inp" type="date" data-pay-input="' + idx + '" aria-label="Proposed pay date for ' + esc(r.vendor) + '"><div><button type="button" class="tbtn" data-act="save-pay" data-idx="' + idx + '">Save date</button></div><div class="sec-sub">Saving a date does not pay the vendor.</div></div>');
    }).join(''));
  }
  function futureCards(f) {
    if (!f.future.length) return '<div class="sec-sub">No future-dated bills were listed on this snapshot.</div>';
    return list(f.future.map(function (b) {
      return vendorCard(b.vendor, Number(b.open_balance), '', '<div class="fin-item-meta">Bill ' + esc(b.bill_id || '') + ' · bill date ' + esc(fmtDay(b.bill_date)) + '</div><div class="fin-badges">' + badge('st-n', 'Future-dated · QuickBooks book') + '</div>');
    }).join(''));
  }
  function dueBlock(f) {
    let html = pendingBox('Due dates are not in this snapshot. The full total of bills due in the next 14 days, and cash left after that full total, is pending Amber.');
    html += '<div class="sec-sub">The cards below are open bills whose bill date falls in the next 14 days. Book cash after them is only that subset.</div>';
    html += tiles(tile(f.futureSum, 'Future-dated bills') + tile(f.book, 'Book cash') + tile(f.left, 'Book cash after these bills'));
    html += futureCards(f);
    return html;
  }
  function arCards(p) {
    if (!p || !p.ar_buckets) return '';
    const b = p.ar_buckets;
    const rows = [
      ['Not due / due today', b.not_due_or_due_today, ''],
      ['1–30 overdue', b.d1_30, ''],
      ['31–45 overdue', b.d31_45, 'warn'],
      ['46–60 overdue', b.d46_60, 'bad'],
      ['61+ overdue', b.d61_plus, 'bad']
    ];
    let html = '<div class="sec-sub">' + esc(p.ar_basis || 'Due-date buckets on the snapshot. Separate from AP bill-date aging. Unconfirmed.') + '</div>' + list(rows.map(function (r) {
      return vendorCard(r[0], Number(r[1]), r[2], '<div class="fin-item-meta">QuickBooks book · unconfirmed</div>');
    }).join(''));
    if (Array.isArray(p.ar_61_plus_detail) && p.ar_61_plus_detail.length) {
      html += '<div class="sec-sub">61+ AR named on the snapshot</div>' + list(p.ar_61_plus_detail.map(function (n) {
        return vendorCard(n.name, Number(n.amount), 'bad', '<div class="fin-item-meta">QuickBooks book · unconfirmed</div>');
      }).join(''));
    }
    return html;
  }
  function exceptions(f) {
    const items = [];
    if (f.pc.confirmation_status) items.push(f.pc.confirmation_status);
    if (f.ap != null && f.pd.ap_control_balance != null) {
      items.push('Open bills ' + money(f.ap) + ' and the A/P control ' + money(f.pd.ap_control_balance) + ' differ by ' + money((cents(f.ap) - cents(Number(f.pd.ap_control_balance))) / 100) + '. ' + (f.pd.ap_control_note || ''));
    }
    if (f.gap != null) items.push('Amber sheet bank minus QuickBooks book is ' + money(f.gap) + '. Unconfirmed. Not spendable cash.');
    if (f.pc.amber_holding_note) items.push(f.pc.amber_holding_note);
    if (!f.pd.due_next_14d && !f.pb.due_next_14d) items.push('The full total of bills due in the next 14 days is not in this snapshot.');
    if (!items.length) items.push('No exceptions are written on this snapshot.');
    return list(items.map(function (t) {
      return '<article class="fin-item"><div class="fin-item-meta" style="margin:0">' + esc(t) + '</div></article>';
    }).join(''));
  }
  function duplicateCards(lines) {
    const map = {};
    lines.forEach(function (b) {
      const key = [b.vendor, b.bill_date, Number(b.open_balance).toFixed(2)].join('|');
      if (!map[key]) map[key] = [];
      map[key].push(b);
    });
    const groups = Object.keys(map).map(function (k) { return map[k]; }).filter(function (g) { return g.length > 1; });
    if (!lines.length) return pendingBox('Open bill lines are not on this snapshot, so a duplicate check cannot be run.');
    if (!groups.length) return '<div class="sec-sub">No two open bills share the same vendor, bill date, and amount.</div>';
    return list(groups.map(function (g) {
      const body = g.map(function (b) {
        return '<div class="fin-subitem"><span>Bill ' + esc(b.bill_id) + ' · ' + esc(fmtDay(b.bill_date)) + '</span><span>' + money(b.open_balance) + '</span></div>';
      }).join('');
      return vendorCard(g[0].vendor, g[0].open_balance, 'warn', '<div class="fin-badges">' + badge('st-a', 'Possible duplicate') + '</div><div class="fin-item-meta">Same vendor, same bill date, and same open amount, with different bill ids.</div>' + body);
    }).join(''));
  }

  function renderOverview() {
    const f = pack();
    if (!f.cash && !f.dec) return empty('No finance snapshot is in the log yet. Pending Amber. No stand-in balance is shown.');
    return rhythm() + scoreLegend(f) + sourceLine(f.cash || f.dec) +
      '<div class="sec-sub">Header cash on hand is the weekly KPI. The tiles below keep the QuickBooks book and Amber’s sheet apart.</div>' +
      section('Cash, AR, and AP', coreTiles(f)) +
      section('Aging buckets', f.aging ? tiles(['current_0_30', '31_45', '46_60', '60_plus'].map(function (k) {
        return tile(f.aging[k], bucketLabel(k) + (k === 'current_0_30' ? ' incl. future' : k === '60_plus' ? ' (61+ on the snapshot)' : ''));
      }).join('')) : pendingBox('Aging buckets are not in this snapshot.')) +
      section('Red list', f.reds.length ? list(f.reds.map(function (r) {
        return vendorCard(r.vendor, Number(r.past_45), 'bad', '<div class="fin-item-meta">Oldest bill ' + esc(r.oldest_bill ? fmtDay(r.oldest_bill) : 'not on file') + ' · past-45 portion</div>');
      }).join('')) : pendingBox('No red-vendor list is in this snapshot.'));
  }
  function renderCash() {
    const f = pack();
    if (!f.cash) return empty('No cash snapshot is in the log yet. Pending Amber.');
    return sourceLine(f.cash) + section('Book and sheet, kept apart', cashTiles(f)) + section('Accounts and sheet lines', accountList(f));
  }
  function renderDecisions() {
    const f = pack();
    if (!f.dec && !f.cash) return empty('No cash, AR, or AP snapshot is in the log yet. Pending Amber.');
    let html = rhythm() + sourceLine(f.dec || f.cash);
    html += '<div class="sec-sub">Exact cash, AR, and AP for Dan’s Tuesday and Friday decisions. The book and the sheet are not blended.</div>';
    html += section('Decision numbers', coreTiles(f) + '<div class="sec-sub">' +
      (f.pd.ar_invoice_count ? esc(f.pd.ar_invoice_count + ' open invoices. ') : '') +
      (f.pd.ap_bill_count ? esc(f.pd.ap_bill_count + ' open bills. ') : '') +
      'Amber confirmation is still open.</div>');
    html += section('Receivables', arCards(f.pd) || pendingBox('AR bucket detail is not in this snapshot.'));
    html += section('Exceptions for Rich', exceptions(f));
    return html;
  }
  function renderAging() {
    const f = pack();
    if (!f.aging && !f.lines.length) return empty('No AP aging snapshot is in the log yet. Pending Amber.');
    let html = '<div class="sec-sub">Buckets are days since the bill date. Current is 0–30 and includes future-dated bills. 60+ is the snapshot’s 61+ bucket.</div>';
    html += sourceLine(f.bill || f.dec);
    if (f.pb.ap_aging_basis || f.pd.ap_aging_basis) html += '<div class="sec-sub">' + esc(f.pb.ap_aging_basis || f.pd.ap_aging_basis) + '</div>';
    if (f.aging) {
      html += section('Bucket totals', tiles(['current_0_30', '31_45', '46_60', '60_plus'].map(function (k) {
        return tile(f.aging[k], bucketLabel(k));
      }).join('')));
    }
    html += section('By vendor', agingCards(f));
    return html;
  }
  function renderRed() {
    const f = pack();
    if (!f.reds.length) return empty('No red-vendor list is in the latest snapshots. Pending Amber. Proposed pay dates stay blank until Dan saves one here.');
    return sourceLine(f.red || f.dec) +
      '<div class="sec-sub">Vendors past 45 days from the bill date. The amount is the past-45 portion. Proposed pay date starts blank.</div>' +
      (f.past != null ? '<div class="sec-sub">Stated past-45 total ' + money(f.past) + '.</div>' : '') +
      redCards(f);
  }
  function renderDue() {
    const f = pack();
    if (!f.dec && !f.bill) return empty('No 14-day bill snapshot is in the log yet. Pending Amber.');
    return sourceLine(f.bill || f.dec) + dueBlock(f);
  }
  function renderAutopay() {
    const f = pack();
    const snap = f.bill || f.dec;
    if (!snap) return empty('No autopay or duplicate-bill snapshot is in the log yet. Pending Amber.');
    const note = (snap.payload && snap.payload.autopay) || f.pc.autopay || f.pd.autopay;
    let html = sourceLine(snap);
    html += '<div class="fin-note">' + esc(note || 'Autopay status is not in this snapshot. Pending Amber.') + '</div>';
    html += section('Duplicate check', duplicateCards(f.lines));
    const notes = entries('portal_autopay_note');
    html += section('Notes on this desk', notes.length ? list(notes.map(function (s) {
      return vendorCard('Review note', fmtWhen(s.logged_at), 'mute', '<div class="fin-item-meta">' + esc((s.payload && s.payload.note) || '') + '</div>');
    }).join('')) : '<div class="sec-sub">No autopay note has been saved.</div>');
    html += '<div class="fin-form"><label class="sec-sub" style="margin:0">Add a review note</label><textarea id="fin-autopay-note" placeholder="What Amber checked. This note is not a payment."></textarea><div><button type="button" class="tbtn green" data-act="save-autopay">Save note</button></div></div>';
    return html;
  }
  function renderContacts() {
    const rows = entries('portal_contact');
    const vendors = ((redSnap() && redSnap().payload && redSnap().payload.red_vendors) || []).map(function (r) {
      return '<option value="' + esc(r.vendor) + '"></option>';
    }).join('');
    let html = '<div class="sec-sub">Vendor contact log. Saving adds a note. It does not email the vendor.</div>';
    html += rows.length ? list(rows.map(function (s) {
      const p = s.payload || {};
      return vendorCard(p.vendor || 'Vendor', fmtWhen(s.logged_at), 'mute', '<div class="fin-item-meta">' + esc(p.who || 'Who not named') + (p.contact_date ? ' · ' + esc(fmtDay(p.contact_date)) : '') + '</div><div class="fin-item-meta">' + esc(p.note || '') + '</div>');
    }).join('')) : pendingBox('No vendor contacts are logged yet.');
    html += '<div class="fin-form"><label class="sec-sub" style="margin:0">Vendor</label><input class="actual-inp" id="fin-contact-vendor" list="fin-vendor-list"><datalist id="fin-vendor-list">' + vendors + '</datalist><label class="sec-sub" style="margin:0">Who spoke</label><input class="actual-inp" id="fin-contact-who"><label class="sec-sub" style="margin:0">Contact date</label><input class="actual-inp" id="fin-contact-when" type="date"><label class="sec-sub" style="margin:0">Note</label><textarea id="fin-contact-note"></textarea><div><button type="button" class="tbtn green" data-act="save-contact">Save contact</button></div></div>';
    return html;
  }
  function renderDrafts() {
    const rows = entries('portal_draft');
    const snap = redSnap();
    const options = '<option value="">Select a red-list vendor</option>' + ((snap && snap.payload && snap.payload.red_vendors) || []).map(function (r) {
      return '<option value="' + esc(r.vendor) + '">' + esc(r.vendor) + '</option>';
    }).join('');
    let html = '<div class="fin-note">Drafts stay on this page for review. This desk has no send control and does not email anyone.</div>';
    html += rows.length ? list(rows.map(function (s, idx) {
      const p = s.payload || {};
      return vendorCard(p.vendor || 'Draft', 'DRAFT', 'mute',
        '<div class="fin-badges">' + badge('st-a', 'Draft only') + '</div>' +
        '<div class="fin-item-meta">' + esc(fmtWhen(s.logged_at)) + (p.to ? ' · ' + esc(p.to) : '') + '</div>' +
        '<div class="fin-item-meta">' + esc(p.subject || '') + '</div>' +
        '<div class="fin-item-meta" style="white-space:pre-wrap">' + esc(p.body || '') + '</div>' +
        '<div><button type="button" class="tbtn" data-act="copy-draft" data-idx="' + idx + '">Copy text</button></div>');
    }).join('')) : pendingBox('No drafts yet.');
    html += '<div class="fin-form"><label class="sec-sub" style="margin:0">Red-list vendor</label><select class="actual-inp" id="fin-draft-vendor">' + options + '</select><label class="sec-sub" style="margin:0">To (stored on the draft, not used to send)</label><input class="actual-inp" id="fin-draft-to" autocomplete="off"><label class="sec-sub" style="margin:0">Subject</label><input class="actual-inp" id="fin-draft-subject"><label class="sec-sub" style="margin:0">Body</label><textarea id="fin-draft-body"></textarea><div><button type="button" class="tbtn" data-act="fill-draft">Fill from red list</button> <button type="button" class="tbtn green" data-act="save-draft">Save draft</button></div><div class="sec-sub">Save draft keeps the text here. It does not send email.</div></div>';
    return html;
  }
  function sheetLinks(p) {
    let html = '<div class="fin-badges">';
    if (p.amber_sheet_url) html += '<a class="link-chip" href="' + esc(p.amber_sheet_url) + '" target="_blank" rel="noopener">Amber check-balance sheet' + (p.amber_sheet_tab ? ' · ' + esc(p.amber_sheet_tab) : '') + '</a>';
    if (p.portal_sheet_url) html += '<a class="link-chip" href="' + esc(p.portal_sheet_url) + '" target="_blank" rel="noopener">Read-only source snapshot</a>';
    html += '</div>';
    if (!p.amber_sheet_url && !p.portal_sheet_url) html += '<div class="sec-sub">No sheet link is stored on this snapshot.</div>';
    return html;
  }
  function renderMeetings() {
    const f = pack();
    const p = f.pc || {};
    const recap = [
      ['Conversation', 'Dan called the November 6 conversation productive.'],
      ['One dashboard', 'He wants one financial dashboard in the Command Center as the single source of truth.'],
      ['Amber’s process', 'Amber can keep her bank reconciliation and check-balance process, and upload into the dashboard instead of sending screenshots, statements, and emails.'],
      ['Tue / Fri', 'Formal Tuesday and Friday snapshots of actual cash, AR, AP, and upcoming obligations, each with a clear cutoff time.'],
      ['Where the time goes', 'He wants time on profitability, cash flow, expenses, and cuts, rather than reconstructing cash from emails.'],
      ['Green / yellow / red', 'He likes that system for financial performance and for employee productivity.'],
      ['Access', 'He asked Rich for access to review the systems.'],
      ['With Amber', 'He will work with Amber on the Tuesday/Friday process.'],
      ['Cadence he proposed', 'A regular monthly financial and operational strategy meeting, a more comprehensive quarterly review, and an annual planning session.']
    ];
    let html = '<div class="sec-sub">November 6, 2026. Dan Young emailed Rich after the meeting. These are the points from that recap. No other meeting notes are on file.</div>';
    html += '<div class="fin-badges"><a class="link-chip" href="https://fathom.video/share/6bchNQeD7g6dPdCz_NJqweECgA15rYB9" target="_blank" rel="noopener">Recording · 47 minutes</a></div>';
    html += section('Dan’s November 6 recap', list(recap.map(function (row) {
      return vendorCard(row[0], '', 'mute', '<div class="fin-item-meta">' + esc(row[1]) + '</div>');
    }).join('')));
    html += section('Tuesday and Friday rhythm', rhythm());
    html += section('Amber’s bank and check uploads',
      '<div class="sec-sub">No bank login and no two-factor on this desk. Amber’s check-balance sheet is DRI: AP Checks Written 2026. Screenshots and statements she provides are not stored on this desk yet.</div>' +
      sheetLinks(p));
    html += section('Monday standing items', list([
      ['Cash by account versus the previous snapshot', 'cash'],
      ['AP aging', 'aging'],
      ['Red list of vendors past 45-day terms', 'red'],
      ['Bills due in the next 14 days and cash left after', 'due'],
      ['Autopay and duplicate-bill check', 'autopay'],
      ['Vendor contact log', 'contacts'],
      ['Draft vendor-update emails', 'drafts']
    ].map(function (row) {
      return vendorCard(row[0], 'Open', 'mute', '<div><button type="button" class="tbtn" data-fin-view="' + row[1] + '">Open</button></div>');
    }).join('')));
    html += section('Annual planning', blankAnnual());
    return html;
  }
  function blankAnnual() {
    return vendorCard('Annual planning session', 'Not written', 'mute', '<div class="fin-item-meta">Dan proposed an annual planning session on November 6. An agenda is not on file.</div>');
  }
  function renderWeekly() {
    const f = pack();
    if (!f.cash && !f.dec) return empty('No snapshot is on file for this agenda. Pending Amber.');
    return rhythm() + sourceLine(f.cash || f.dec) +
      '<div class="sec-sub">Dan and Rich. Each block below is a weekly agenda item. Numbers are the Tuesday/Friday snapshot. Items with no entry stay marked not on file.</div>' +
      section('Cash position', cashTiles(f) + accountList(f)) +
      section('AR', tiles(tile(f.ar, 'Open AR')) + arCards(f.pd)) +
      section('AP', tiles(tile(f.ap, 'Open AP') + tile(f.past, 'Past 45 days'))) +
      section('Red-list vendors past 45 days', f.reds.length ? list(f.reds.map(function (r) {
        return vendorCard(r.vendor, Number(r.past_45), 'bad', '<div class="fin-item-meta">Oldest bill ' + esc(r.oldest_bill ? fmtDay(r.oldest_bill) : 'not on file') + '</div>');
      }).join('')) : pendingBox('No red list on this snapshot.')) +
      section('Bills due in the next 14 days', dueBlock(f)) +
      section('Decisions and approvals', vendorCard('Decisions and approvals', 'Not on file', 'mute', '<div class="fin-item-meta">None are logged on this snapshot. Proposed pay dates on the red list stay blank until Dan saves one. Saving a date does not pay a vendor.</div>')) +
      section('Exceptions that need Rich', exceptions(f));
  }
  function renderMonthly() {
    const f = pack();
    return rhythm() +
      '<div class="sec-sub">Dan proposed this monthly financial and operational strategy meeting on November 6. No monthly minutes are on file. The verified picture is the Tuesday/Friday snapshot.</div>' +
      (f.cash || f.dec ? sourceLine(f.cash || f.dec) : '') +
      section('Progress versus the verified numbers', (f.cash || f.dec ? coreTiles(f) : '') + vendorCard('Monthly progress', 'Not on file', 'mute', '<div class="fin-item-meta">No prior monthly close is on file. The tiles above, when present, are the current snapshot, not a month-over-month result.</div>')) +
      section('Expenses and cuts', vendorCard('Expenses and cuts', 'Not on file', 'mute', '<div class="fin-item-meta">Dan wants this discussed. No expense or cut figures are on this snapshot.</div>')) +
      section('Cash flow', vendorCard('Cash flow', 'Not on file', 'mute', '<div class="fin-item-meta">A cash-flow plan is not on file. Book cash and Amber’s sheet bank above are the verified cash picture, not a forecast.</div>') + (f.cash ? cashTiles(f) : '')) +
      section('Reactive to proactive', vendorCard('Management posture', 'Not scored', 'mute', '<div class="fin-item-meta">Whether the company is moving from reactive to proactive management is not recorded.</div>'));
  }
  function renderQuarterly() {
    const f = pack();
    return rhythm() +
      '<div class="sec-sub">Quarterly review. Dan comes out and presents the fuller review he described on November 6. No quarterly pack or past quarterly minutes are on file.</div>' +
      section('Financial performance', vendorCard('Quarterly performance', 'Not on file', 'mute', '<div class="fin-item-meta">The current Tuesday/Friday snapshot is the only verified picture on this desk. It is not a quarterly result.</div>') + (f.cash || f.dec ? coreTiles(f) + sourceLine(f.cash || f.dec) : '')) +
      section('Staffing and compensation versus productivity', vendorCard('Staffing / compensation / productivity', 'Not on file', 'mute', '<div class="fin-item-meta">Dan named this as part of the quarterly review. No staffing, compensation, or productivity figures are on file.</div>')) +
      section('Whether the operating model is working', vendorCard('Operating model', 'Not on file', 'mute', '<div class="fin-item-meta">Not recorded. This is a topic for the review Dan presents, not a completed conclusion.</div>'));
  }

  function render() {
    if (drawing) return;
    const focused = document.activeElement;
    const panel = document.getElementById('panel-findesk');
    if (focused && panel && panel.contains(focused) && focused.matches('input,textarea,select')) return;
    drawing = true;
    const views = {
      overview: renderOverview,
      cash: renderCash,
      decisions: renderDecisions,
      aging: renderAging,
      red: renderRed,
      due: renderDue,
      autopay: renderAutopay,
      contacts: renderContacts,
      drafts: renderDrafts,
      meetings: renderMeetings,
      weekly: renderWeekly,
      monthly: renderMonthly,
      quarterly: renderQuarterly
    };
    Object.keys(views).forEach(function (name) {
      const el = document.getElementById('fin-view-' + name);
      if (el) el.innerHTML = views[name]();
      const btn = document.querySelector('#fin-subtabs [data-fin-view="' + name + '"]');
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
