#!/usr/bin/env node
// Rendered smoke test for an /idea prototype — headless Firefox over WebDriver
// BiDi, with no dependencies beyond node's built-in WebSocket.
//
//   node smoke.mjs <url> <profile-dir>   → one JSON object on stdout
//
// It reports what a person would see, not what the source says: JavaScript
// errors, template syntax left unrendered on screen ("{{ progress }}"), a
// blank page, and, for each visible control, whether clicking it changed the
// page. `ok` is false on any error, unrendered syntax, a blank page, or when
// no control does anything. It also captures screenshots (mobile initial and
// end state, desktop initial) so a vision-capable reviewer can judge the
// visual result. The transcript goes to the reviewers, so a model judges
// behaviour it could not see from the source alone ("one tap marked all
// eight glasses").
//
// The profile directory must be one snap Firefox can read (under
// ~/snap/firefox/common/ when Firefox is the snap build).

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeSync } from 'node:fs';
import net from 'node:net';

const [url, profile] = process.argv.slice(2);
if (!url || !profile) {
  console.error('usage: node smoke.mjs <url> <profile-dir>');
  process.exit(2);
}
const MAX_CONTROLS = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const port = await freePort();
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', profile,
  `--remote-debugging-port=${port}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let ffErr = '';
ff.stderr.on('data', (d) => { ffErr += d; });
const kill = () => { try { process.kill(-ff.pid, 'SIGTERM'); } catch { /* gone */ } };
const watchdog = setTimeout(() => { done({ ok: false, errors: ['smoke test timed out after 90s'] }); }, 90_000);

function done(result) {
  clearTimeout(watchdog);
  kill();
  rmSync(profile, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

let ws;
for (let i = 0; i < 40 && !ws; i++) {
  await sleep(500);
  if (!ffErr.includes('WebDriver BiDi listening')) continue;
  const sock = new WebSocket(`ws://127.0.0.1:${port}/session`);
  ws = await new Promise((resolve) => {
    sock.onopen = () => resolve(sock);
    sock.onerror = () => resolve(null);
  });
}
if (!ws) done({ ok: false, errors: [`Firefox did not start: ${ffErr.slice(-300)}`] });

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.type === 'error' ? reject(new Error(`${msg.error}: ${msg.message}`)) : resolve(msg.result);
  } else if (msg.method === 'log.entryAdded') {
    const e = msg.params;
    if (e.level === 'error' || e.type === 'javascript') consoleErrors.push(String(e.text).slice(0, 300));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

try {
  await send('session.new', { capabilities: {} });
  await send('session.subscribe', { events: ['log.entryAdded'] });
  const tree = await send('browsingContext.getTree', {});
  const context = tree.contexts[0].context;
  await send('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 } });
  await send('browsingContext.navigate', { context, url, wait: 'complete' });
  await sleep(2500); // CDN scripts and framework init

  const evalJson = async (expression) => {
    const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || 'script exception');
    return JSON.parse(r.result.value);
  };
  const SNAP = `JSON.stringify((document.body ? document.body.innerText : '').replace(/[ \\t]+/g, ' ').trim())`;

  const shot = async () => {
    const r = await send('browsingContext.captureScreenshot', { context, origin: 'viewport' });
    return r.data; // base64 png
  };

  const initial = await evalJson(SNAP);
  const shots = { mobile: await shot() };
  const unrendered = [...new Set((initial.match(/\{\{[^}]{0,40}\}\}|\$\{[^}]{0,40}\}|\[\[[^\]]{0,40}\]\]/g) || []))];
  const labels = await evalJson(`(() => {
    const els = [...document.querySelectorAll('button, [role=button], a[href], input[type=checkbox], input[type=radio], select, [onclick], [x-on\\\\:click], [\\\\@click]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    window.__smokeEls = els.slice(0, ${MAX_CONTROLS});
    // Links must not navigate away mid-test: keep their click handlers, drop the navigation.
    window.__smokeNoNav = (e) => { if (e.target && e.target.closest && e.target.closest('a[href]')) e.preventDefault(); };
    document.addEventListener('click', window.__smokeNoNav, { capture: true });
    return JSON.stringify(window.__smokeEls.map((el, i) =>
      (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.tagName).trim().slice(0, 40) || ('#' + i)));
  })()`);

  const steps = [];
  let before = initial;
  for (let i = 0; i < labels.length; i++) {
    await evalJson(`(() => { const el = (window.__smokeEls || [])[${i}]; if (el && el.isConnected) el.click(); return 'null'; })()`);
    await sleep(400);
    const after = await evalJson(SNAP);
    const a = new Set(before.split('\n')), b = new Set(after.split('\n'));
    const added = [...b].filter((l) => !a.has(l)).slice(0, 3);
    const removed = [...a].filter((l) => !b.has(l)).slice(0, 3);
    steps.push({ control: labels[i], changed: after !== before, added, removed });
    before = after;
  }
  shots.mobileEnd = await shot();

  // Desktop pass: same page, wide viewport — layout and overflow problems
  // only show up here.
  await send('browsingContext.setViewport', { context, viewport: { width: 1280, height: 800 } });
  await send('browsingContext.reload', { context, wait: 'complete' });
  await sleep(2500);
  shots.desktop = await shot();
  let overflow = null;
  try {
    overflow = await evalJson(`(() => {
      const el = document.documentElement;
      return JSON.stringify({ h: el.scrollWidth > el.clientWidth + 1, v: el.scrollHeight > el.clientHeight + 1 });
    })()`);
  } catch { /* non-fatal */ }

  const errors = [...new Set(consoleErrors)];
  const blank = initial.length < 20;
  const dead = steps.length > 0 && steps.every((s) => !s.changed);
  const problems = [
    ...errors.map((e) => `console error: ${e}`),
    ...unrendered.map((u) => `unrendered template syntax on screen: ${u}`),
    ...(blank ? ['the page renders (almost) no text'] : []),
    ...(dead ? [`none of the ${steps.length} controls changed anything when clicked`] : []),
    ...(overflow?.h ? ['page overflows horizontally on desktop (1280px)'] : []),
  ];
  done({ ok: problems.length === 0, errors: problems, initialText: initial.slice(0, 1500), steps, shots });
} catch (e) {
  done({ ok: false, errors: [`smoke test failed: ${e.message}`] });
}
