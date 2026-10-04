const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const tests = [];
function test(name, run) { tests.push({ name, run }); }

const html = fs.readFileSync(path.join(__dirname, '../researcher.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const helper = script.slice(script.indexOf('  var adminDownloadBusy='), script.indexOf('  function esc(s)'));

function setup() {
  let focused;
  let downloads = 0;
  let revoked = 0;
  let frame;
  const timers = new Map();
  let timerId = 0;
  function element(tagName = 'DIV') {
    const classes = new Set();
    return {
      tagName, disabled: false, hidden: false, inert: false, isConnected: true,
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
      },
      listeners: {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
      focus() { focused = this; },
      click() { downloads++; },
      remove() {},
    };
  }
  const ids = Object.fromEntries(['transcriptDownloadDialog', 'transcriptDownloadClose', 'transcriptDownloadTitle', 'transcriptDownloadMessage'].map(id => [id, element()]));
  const background = element();
  const alreadyInert = element();
  alreadyInert.inert = true;
  const context = vm.createContext({
    document: {
      getElementById: id => ids[id],
      body: { children: [background, alreadyInert, ids.transcriptDownloadDialog], appendChild() {} },
      createElement: element,
    },
    requestAnimationFrame(callback) { frame = callback; },
    setTimeout(callback, delay) {
      if (delay === 0 || delay === 1000) { queueMicrotask(callback); return 0; }
      timers.set(++timerId, callback); return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    AbortController: class {
      constructor() {
        this.listeners = [];
        this.signal = { addEventListener: (name, listener) => this.listeners.push(listener) };
      }
      abort() { this.listeners.forEach(listener => listener()); }
    },
    Promise, Map, Date,
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() { revoked++; } },
    AI_US_API_BASE: 'https://api.invalid', AI_US_ACCESS_TOKEN: 'test-only',
    sessionStorage: { removeItem() {} }, window: { location: {} },
    fetch() { throw new Error('Unexpected request'); },
  });
  vm.runInContext(helper, context);
  return { context, ids, background, alreadyInert, timers, element,
    paint() { const callback = frame; frame = undefined; callback(); },
    focused: () => focused, downloads: () => downloads, revoked: () => revoked,
    dismiss() { ids.transcriptDownloadClose.listeners.click(); },
  };
}

function jsonResponse(data, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}

test('entire inline script parses and obsolete download paths are gone', () => {
  new vm.Script(script);
  for (const name of ['bulkDownloadBusy', 'transcriptDownloadBusy', 'downloadBlobResponse', 'setTranscriptBusy']) {
    assert.equal(script.includes(name), false, name);
  }
  assert.equal((helper.match(/fetch\(/g) || []).length, 1);
  assert.equal(/fetch\([^\n]*(?:latest-parse\/download|files\/[^\n]*\/download|transcript-download-jobs|download-jobs)/.test(script), false);
  assert.equal((script.match(/runAdminDownload\(/g) || []).length, 11);
});

test('local generation paints first, locks all buttons, and restores inert/focus', async () => {
  const harness = setup();
  const { context, ids, background, alreadyInert } = harness;
  const button = harness.element('BUTTON');
  let calls = 0;
  const result = context.runAdminDownload(button, 'Local CSV', () => {
    assert.equal(ids.transcriptDownloadDialog.classList.contains('open'), true);
    calls++;
  });
  assert.equal(context.adminDownloadBusy, true);
  assert.equal(button.disabled, true);
  assert.equal(background.inert, true);
  assert.equal(ids.transcriptDownloadClose.hidden, true);
  assert.equal(calls, 0);
  assert.equal(await context.runAdminDownload(button, 'Duplicate', () => calls++), false);
  assert.equal(await context.runAdminDownload(harness.element('BUTTON'), 'Other', () => calls++), false);
  harness.paint();
  assert.equal(await result, true);
  assert.equal(calls, 1);
  assert.equal(context.adminDownloadBusy, false);
  assert.equal(button.disabled, false);
  assert.equal(background.inert, false);
  assert.equal(alreadyInert.inert, true);
  assert.equal(harness.focused(), button);
  assert.equal(ids.transcriptDownloadDialog.classList.contains('open'), false);
});

test('errors unlock but remain modal until dismissed; retry succeeds', async () => {
  const harness = setup();
  const { context, ids } = harness;
  const button = harness.element('BUTTON');
  const result = context.runAdminDownload(button, 'File', () => { throw new Error('test failure'); });
  harness.paint();
  assert.equal(await result, false);
  assert.equal(context.adminDownloadBusy, false);
  assert.equal(button.disabled, false);
  assert.equal(ids.transcriptDownloadClose.hidden, false);
  assert.equal(ids.transcriptDownloadMessage.textContent, 'test failure');
  assert.equal(harness.background.inert, true);
  assert.equal(await context.runAdminDownload(button, 'Retry', () => {}), false);
  harness.dismiss();
  assert.equal(harness.background.inert, false);
  const retry = context.runAdminDownload(button, 'Retry', () => {});
  harness.paint();
  assert.equal(await retry, true);
});

test('busy keyboard dismissal is blocked and error dismissal restores focus', async () => {
  const harness = setup();
  const { context, ids } = harness;
  const button = harness.element('BUTTON');
  const result = context.runAdminDownload(button, 'File', () => Promise.reject(new Error('error')));
  const keydown = ids.transcriptDownloadDialog.listeners.keydown;
  keydown.call(ids.transcriptDownloadDialog, { key: 'Escape', preventDefault() {} });
  harness.dismiss();
  assert.equal(ids.transcriptDownloadDialog.classList.contains('open'), true);
  harness.paint();
  await result;
  keydown.call(ids.transcriptDownloadDialog, { key: 'Tab', preventDefault() {} });
  assert.equal(harness.focused(), ids.transcriptDownloadClose);
  keydown.call(ids.transcriptDownloadDialog, { key: 'Escape', preventDefault() {} });
  assert.equal(harness.focused(), button);
  assert.equal(context.adminDownloadErrorOpen, false);
});

test('ZIP creation failure releases busy state and permits explicit retry', async () => {
  const harness = setup();
  const { context } = harness;
  let posts = 0;
  context.fetch = async (url, options) => {
    if (options.method === 'POST') { posts++; return jsonResponse({ detail: 'Unavailable' }, 503); }
    throw new Error('Unexpected polling');
  };
  const button = harness.element('BUTTON');
  const start = () => context.runAdminDownload(button, 'ZIP', () => context.downloadAdminArchive('/jobs', { ids: ['one'] }, 'out.zip'));
  let result = start(); harness.paint();
  assert.equal(await result, false);
  assert.equal(context.adminDownloadBusy, false);
  assert.equal(context.adminDownloadJobs.size, 0);
  assert.equal(harness.timers.size, 0);
  harness.dismiss();
  result = start(); harness.paint();
  assert.equal(await result, false);
  assert.equal(posts, 2);
});

for (const failedStage of ['poll', 'file']) {
  test(`ZIP ${failedStage} error reuses known job and downloads once on retry`, async () => {
    const harness = setup();
    const { context } = harness;
    let posts = 0;
    let fail = true;
    context.fetch = async (url, options) => {
      if (options.method === 'POST') { posts++; return jsonResponse({ jobId: 'known' }); }
      if (url.endsWith('/jobs/known')) {
        if (fail && failedStage === 'poll') throw new Error('Disconnected');
        return jsonResponse({ status: 'completed', downloadUrl: '/file' });
      }
      if (fail) throw new Error('Disconnected');
      return { ok: true, status: 200, headers: { get: () => 'attachment; filename="ready.zip"' }, blob: async () => ({}) };
    };
    await assert.rejects(context.downloadAdminArchive('/jobs', { ids: ['one'] }, 'out.zip'));
    assert.equal(context.adminDownloadJobs.size, 1);
    fail = false;
    await context.downloadAdminArchive('/jobs', { ids: ['one'] }, 'out.zip');
    assert.equal(posts, 1);
    assert.equal(context.adminDownloadJobs.size, 0);
    assert.equal(harness.downloads(), 1);
    assert.equal(harness.revoked(), 1);
    assert.equal(harness.timers.size, 0);
  });
}

test('server file modal stays open until blob handoff completes', async () => {
  const harness = setup();
  let resolveBlob;
  let requested;
  const requestStarted = new Promise(resolve => { requested = resolve; });
  harness.context.fetch = async () => {
    requested();
    return { ok: true, status: 200, headers: { get: () => '' }, blob: () => new Promise(resolve => { resolveBlob = resolve; }) };
  };
  const button = harness.element('BUTTON');
  const result = harness.context.runAdminDownload(button, 'File', () => harness.context.downloadAdminFile('/file', 'out.csv'));
  harness.paint();
  await requestStarted;
  await Promise.resolve();
  assert.equal(harness.context.adminDownloadBusy, true);
  assert.equal(harness.ids.transcriptDownloadDialog.classList.contains('open'), true);
  assert.equal(harness.downloads(), 0);
  resolveBlob({});
  assert.equal(await result, true);
  assert.equal(harness.downloads(), 1);
  assert.equal(harness.revoked(), 1);
  assert.equal(harness.ids.transcriptDownloadDialog.classList.contains('open'), false);
  assert.equal(harness.timers.size, 0);
});

test('failed server job is removed so explicit retry creates a new job', async () => {
  const harness = setup();
  let posts = 0;
  harness.context.fetch = async (url, options) => options.method === 'POST'
    ? (posts++, jsonResponse({ jobId: 'failed' }))
    : jsonResponse({ status: 'failed', error: 'Worker failure' });
  await assert.rejects(harness.context.downloadAdminArchive('/jobs', {}, 'out.zip'), /Worker failure/);
  assert.equal(harness.context.adminDownloadJobs.size, 0);
  await assert.rejects(harness.context.downloadAdminArchive('/jobs', {}, 'out.zip'), /Worker failure/);
  assert.equal(posts, 2);
});

test('request timeout aborts, reports failure and cleans up its timer', async () => {
  const harness = setup();
  harness.context.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('timeout'); error.name = 'AbortError'; reject(error);
    });
  });
  const pending = harness.context.adminDownloadRequest('/slow', null, true);
  assert.equal(harness.timers.size, 1);
  [...harness.timers.values()][0]();
  await assert.rejects(pending, error => !error.message.includes('timeout'));
  assert.equal(harness.timers.size, 0);
});

(async function runTests() {
  let failures = 0;
  for (const item of tests) {
    try { await item.run(); console.log('PASS ' + item.name); }
    catch (error) { failures++; console.error('FAIL ' + item.name, error); }
  }
  console.log(`${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();