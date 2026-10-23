// Browser checks for the Command Center save guard.
// Run: npm install --prefix /tmp/pw playwright-core && NODE_PATH=/tmp/pw/node_modules node test/browser-save-check.mjs
// Writes to Supabase are aborted or fulfilled locally. This script never lets a mutation reach the project.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shots = '/opt/cursor/artifacts/screenshots';
fs.mkdirSync(shots, { recursive: true });

const TASK = { id: 1, text: 'Keep this to-do', owner: 'Ops', due: '2026-05-07', done: false, category: 'Ops', priority: 'High' };
const EXTRA = { id: 2, text: 'Added on the L10 page', owner: 'Admin', due: '2026-05-08', done: false, category: 'General', priority: 'Medium' };
const FORBIDDEN = ['equipment', 'pm_schedule', 'maint_issues', 'truck_checks', 'rocks', 'issues', 'meeting_notes', 'participants', 'meeting_history', 'pnl'];

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': contentType(file) });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function fulfill(route, status, body) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function baseRow(overrides) {
  return Object.assign({
    week_data: {
      revenue_weekly_w4: 222,
      quote_close_rate_w4: 30,
      vendor_performance_w4: 90,
      cash_on_hand_w4: 1000,
      close_rate_w4: 40,
      jobs_completed_w4: 6,
      secret_key: 7,
    },
    history: [{ date: '2026-10-01', revenue_weekly: 4 }],
    tasks: [TASK],
    pnl: null,
    updated_at: '2026-10-22T20:00:00.000Z',
    equipment: [{ id: 9 }],
  }, overrides);
}

async function launch() {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}

function track(page) {
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  return errors;
}

async function openPage(browser, width) {
  const page = await browser.newPage({ viewport: { width: width || 1280, height: 900 } });
  const errors = track(page);
  await page.routeWebSocket(/supabase\.co/, () => {});
  return { page, errors };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}/`;
const browser = await launch();

try {
  // 1. Real project, read only. Opening the page must not mutate dashboard_data.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = track(page);
    const writes = [];
    await page.route(/supabase\.co/, async route => {
      const method = route.request().method();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        await route.continue();
        return;
      }
      writes.push(method + ' ' + route.request().url().split('?')[0]);
      await route.abort();
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const label = page.locator('#sync-lbl');
    await label.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const text = document.getElementById('sync-lbl').textContent;
      return text.includes('Live') || text.includes("Couldn't load") || text.includes('editing is locked');
    }, null, { timeout: 25000 });
    await page.waitForTimeout(1500);
    const text = await label.innerText();
    const banner = await page.locator('#load-banner').evaluate(el => el.classList.contains('show'));
    check('live read reaches the synced state', text.includes('Live') && banner === false, text);
    check('opening the live page sends no writes', writes.length === 0, writes.join(', ') || 'none');
    check('live page has no script errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // 2. Simulated load failure: editing, shifting, and adding a to-do must not write.
  {
    const { page, errors } = await openPage(browser, 1280);
    const writes = [];
    await page.route(/supabase\.co/, async route => {
      const req = route.request();
      const method = req.method();
      if (method === 'OPTIONS') { await fulfill(route, 204, ''); return; }
      if (method !== 'GET' && method !== 'HEAD') {
        writes.push(method + ' ' + req.url());
        await route.abort();
        return;
      }
      if (req.url().includes('/rest/v1/dashboard_data')) {
        await fulfill(route, 500, { message: 'simulated load failure' });
        return;
      }
      await fulfill(route, 200, {});
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#load-banner.show').waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(shots, 'load-failure-desktop.png') });
    await page.locator('.tab', { hasText: 'Sales' }).click();
    const input = page.locator('#kpi-Sales input').nth(3);
    await input.fill('42');
    await input.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
    await page.getByRole('button', { name: 'Shift Weeks' }).click();
    await page.locator('.tab', { hasText: 'Tasks' }).click();
    await page.locator('#new-task-text').fill('Should not save');
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.waitForTimeout(1200);
    const banner = await page.locator('#load-banner-text').innerText();
    const taskMsg = await page.locator('#task-list').innerText();
    check('failed load shows the lock message', banner.includes("can't overwrite"), banner);
    check('failed load does not pretend the to-do list is empty', taskMsg.includes("didn't load"), taskMsg);
    check('failed load plus edits sends no writes', writes.length === 0, writes.join(', ') || 'none');
    check('failed load has no script errors', errors.length === 0, errors.join(' | '));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(shots, 'load-failure-mobile.png') });
    const box = await page.locator('#load-banner').boundingBox();
    check('lock message fits a phone width', !!box && box.width <= 390 && box.x >= 0, JSON.stringify(box));
    await page.close();
  }

  // 3. A week-number edit patches only that merged week_data.
  {
    const { page, errors } = await openPage(browser);
    const writes = [];
    await page.route(/supabase\.co/, async route => {
      const req = route.request();
      const method = req.method();
      if (method === 'OPTIONS') { await fulfill(route, 204, ''); return; }
      if (req.url().includes('/rest/v1/dashboard_data') && method === 'GET') {
        await fulfill(route, 200, baseRow());
        return;
      }
      if (method === 'PATCH' || method === 'POST' || method === 'PUT' || method === 'DELETE') {
        writes.push({ method, url: req.url(), body: req.postData() });
        await fulfill(route, 200, [{ updated_at: '2026-10-23T00:00:00.000Z' }]);
        return;
      }
      await fulfill(route, 200, {});
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#sync-lbl').filter({ hasText: 'Live' }).waitFor();
    await page.screenshot({ path: path.join(shots, 'loaded-desktop.png') });
    await page.locator('.tab', { hasText: 'Sales' }).click();
    const pending = page.waitForRequest(req => req.method() === 'PATCH');
    const input = page.locator('#kpi-Sales input').nth(3);
    await input.fill('42');
    await input.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
    const req = await pending;
    const patch = JSON.parse(req.postData());
    check('number edit uses PATCH', req.method() === 'PATCH');
    check('number edit is limited to the driven row version', req.url().includes('id=eq.driven_cmd') && req.url().includes('updated_at=eq.'), req.url());
    check('number edit writes week_data only', JSON.stringify(Object.keys(patch).sort()) === JSON.stringify(['updated_at', 'week_data']), JSON.stringify(patch));
    check('number edit keeps keys this page did not change', patch.week_data.secret_key === 7 && patch.week_data.revenue_weekly_w4 === 42, JSON.stringify(patch.week_data));
    check('number edit leaves saved to-dos out of the body', !Object.hasOwn(patch, 'tasks'));
    check('number edit does not send other pages\' columns', FORBIDDEN.every(key => !Object.hasOwn(patch, key)));
    check('number edit has no script errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // 4. Toggling a to-do re-reads and keeps a task that appeared after load.
  {
    const { page, errors } = await openPage(browser);
    let gets = 0;
    let patch = null;
    await page.route(/supabase\.co/, async route => {
      const req = route.request();
      const method = req.method();
      if (method === 'OPTIONS') { await fulfill(route, 204, ''); return; }
      if (req.url().includes('/rest/v1/dashboard_data') && method === 'GET') {
        gets += 1;
        const tasks = gets === 1 ? [TASK] : [Object.assign({}, TASK), EXTRA];
        await fulfill(route, 200, baseRow({ tasks }));
        return;
      }
      if (method === 'PATCH') {
        patch = { url: req.url(), body: JSON.parse(req.postData() || '{}') };
        await fulfill(route, 200, [{ updated_at: '2026-10-23T00:00:01.000Z' }]);
        return;
      }
      await fulfill(route, 200, {});
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#sync-lbl').filter({ hasText: 'Live' }).waitFor();
    await page.locator('.tab', { hasText: 'Tasks' }).click();
    await page.locator('#task-list input[type=checkbox]').click();
    // The click handler saves immediately; wait until the route recorded it.
    for (let i = 0; i < 20 && !patch; i++) await page.waitForTimeout(100);
    check('to-do toggle re-read before writing', gets >= 2, 'gets=' + gets);
    check('to-do toggle keeps the task added since load', patch && patch.body.tasks.length === 2 && patch.body.tasks[1].priority === 'Medium', JSON.stringify(patch && patch.body.tasks));
    check('to-do toggle keeps L10 fields on the edited task', patch && patch.body.tasks[0].done === true && patch.body.tasks[0].category === 'Ops');
    check('to-do toggle does not write week_data', patch && !Object.hasOwn(patch.body, 'week_data'));
    check('to-do toggle has no script errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // 5. Confirming the last delete is the only way to write an empty list.
  {
    const { page, errors } = await openPage(browser);
    const patches = [];
    await page.route(/supabase\.co/, async route => {
      const req = route.request();
      if (req.method() === 'OPTIONS') { await fulfill(route, 204, ''); return; }
      if (req.url().includes('dashboard_data') && req.method() === 'GET') { await fulfill(route, 200, baseRow()); return; }
      if (req.method() === 'PATCH' || req.method() === 'POST') {
        patches.push(JSON.parse(req.postData() || '{}'));
        await fulfill(route, 200, [{ updated_at: '2026-10-23T00:00:02.000Z' }]);
        return;
      }
      await fulfill(route, 200, {});
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#sync-lbl').filter({ hasText: 'Live' }).waitFor();
    await page.locator('.tab', { hasText: 'Tasks' }).click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#task-list button').click();
    await page.waitForTimeout(500);
    check('dismissing the last-to-do confirm writes nothing', patches.length === 0);
    check('dismissing the confirm leaves the to-do on screen', (await page.locator('#task-list').innerText()).includes('Keep this to-do'));
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#task-list button').click();
    for (let i = 0; i < 20 && patches.length === 0; i++) await page.waitForTimeout(100);
    check('confirming the last to-do writes an empty list', patches.length === 1 && Array.isArray(patches[0].tasks) && patches[0].tasks.length === 0, JSON.stringify(patches));
    check('confirmed clear does not write other columns', patches[0] && FORBIDDEN.every(key => !Object.hasOwn(patches[0], key)) && !Object.hasOwn(patches[0], 'week_data'));
    check('delete flow has no script errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // 6. A slow load for Driven must not paint that row onto Trailblazers.
  {
    const { page, errors } = await openPage(browser);
    let releaseDriven;
    const gate = new Promise(resolve => { releaseDriven = resolve; });
    const writes = [];
    await page.route(/supabase\.co/, async route => {
      const req = route.request();
      const method = req.method();
      if (method === 'OPTIONS') { await fulfill(route, 204, ''); return; }
      if (method !== 'GET') {
        writes.push(method);
        await route.abort();
        return;
      }
      if (!req.url().includes('dashboard_data')) { await fulfill(route, 200, {}); return; }
      if (req.url().includes('driven_cmd')) {
        await gate;
        await fulfill(route, 200, baseRow({ week_data: { revenue_weekly_w4: 111 }, tasks: [{ id: 7, text: 'Driven only', owner: 'A', due: '', done: false }] }));
        return;
      }
      await fulfill(route, 200, baseRow({ week_data: { revenue_weekly_w4: 222, close_rate_w4: 40, jobs_completed_w4: 6, cash_on_hand_w4: 1000 }, tasks: [{ id: 8, text: 'Trailblazers only', owner: 'B', due: '', done: false }] }));
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#co-tb').click();
    await page.locator('#co-title').filter({ hasText: 'TRAILBLAZERS' }).waitFor();
    await page.locator('#h-stats').filter({ hasText: '$222' }).waitFor({ timeout: 10000 });
    releaseDriven();
    await page.waitForTimeout(600);
    const stats = await page.locator('#h-stats').innerText();
    const title = await page.locator('#co-title').innerText();
    check('late Driven load does not overwrite Trailblazers', title.includes('TRAILBLAZERS') && stats.includes('$222') && !stats.includes('$111'), title + ' ' + stats.replace(/\s+/g, ' '));
    check('company switch sends no writes', writes.length === 0, writes.join(','));
    check('company switch has no script errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
