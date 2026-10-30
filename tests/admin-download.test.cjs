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
  assert.equal((script.match(/runAdminDownload\(/g) || []).length, 12);
  assert.match(script, /researcher\/survey-progress\?format=csv/);
  assert.match(script, /progressDownload\.addEventListener\('click',[\s\S]*?runAdminDownload\(this,[\s\S]*?downloadAdminFile\(path/);
});

test('worker labels describe stable roles without changing health API fields', () => {
  assert.match(html, /id="workerHealth"[^>]*title="설문 Worker 상태 확인 중 · 설문 제출 처리"[\s\S]*?<span>설문 Worker<\/span>/);
  assert.match(html, /id="analysisWorkerHealth"[^>]*title="관리자 Worker 상태 확인 중 · 현재 관리자 분석 작업 처리"[\s\S]*?<span>관리자 Worker<\/span>/);
  assert.equal(html.includes('분석 Worker'), false);
  assert.match(script, /data\.worker\|\|\{\}/);
  assert.match(script, /data\.analysisWorker\|\|\{\}/);
  for (const label of ['설문 Worker', '관리자 Worker']) {
    for (const state of ['정상', '확인 필요', '상태를 확인할 수 없습니다.']) {
      assert.equal(script.includes(label + ' ' + state), true);
    }
  }
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

function approvalSetup(role = 'admin') {
  let focused;
  const element = () => ({
    hidden: false, inert: false, isConnected: true,
    classList: { add() {}, remove() {} }, listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
    focus() { focused = this; },
  });
  const ids = Object.fromEntries(['autoApprovalDialog', 'autoApprovalTitle', 'autoApprovalMessage', 'autoApprovalYes', 'autoApprovalNo', 'autoApprovalClose', 'autoApprovalSpinner'].map(id => [id, element()]));
  const toggle = element(), background = element(), alreadyInert = element();
  alreadyInert.inert = true;
  const calls = [];
  const document = { getElementById: id => ids[id], body: { children: [background, alreadyInert, ids.autoApprovalDialog] } };
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  const context = vm.createContext({
    window: {}, document, researcherRole: role, autoApprovalToggle: toggle,
    autoApprovalStatus: {}, autoApprovalNote: {},
    aiUsRequest(path, options) { calls.push({ path, options }); return Promise.resolve({ autoApproval: true }); },
  });
  vm.runInContext(script.slice(script.indexOf('    var autoApprovalEnabled='), script.indexOf('    function levelOf(')), context);
  context.autoApprovalLoaded = true;
  context.renderAutoApproval(false);
  return { context, ids, toggle, background, alreadyInert, calls, focused: () => focused };
}

test('auto approval themed confirmation orders yes before no and cancellation sends nothing', () => {
  assert.ok(html.indexOf('id="autoApprovalYes"') < html.indexOf('id="autoApprovalNo"'));
  assert.doesNotMatch(script, /confirm\('자동 승인을/);
  const harness = approvalSetup();
  harness.context.openAutoApprovalDialog(true);
  assert.equal(harness.toggle.checked, false);
  assert.equal(harness.toggle.disabled, true);
  assert.equal(harness.background.inert, true);
  assert.equal(harness.focused(), harness.ids.autoApprovalNo);
  harness.ids.autoApprovalNo.listeners.click();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.toggle.checked, false);
  assert.equal(harness.toggle.disabled, false);
  assert.equal(harness.background.inert, false);
  assert.equal(harness.alreadyInert.inert, true);
  assert.equal(harness.focused(), harness.toggle);
});

test('auto approval saves once after yes and locks dismissal until successful response', async () => {
  const harness = approvalSetup();
  let finish;
  harness.context.aiUsRequest = (path, options) => {
    harness.calls.push({ path, options });
    return new Promise(resolve => { finish = resolve; });
  };
  harness.context.openAutoApprovalDialog(true);
  const pending = harness.ids.autoApprovalYes.listeners.click();
  harness.ids.autoApprovalYes.listeners.click();
  harness.ids.autoApprovalDialog.listeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].options.body.autoApproval, true);
  assert.equal(harness.toggle.checked, false);
  assert.equal(harness.toggle.disabled, true);
  assert.equal(harness.ids.autoApprovalSpinner.hidden, false);
  finish({ autoApproval: true });
  await pending;
  assert.equal(harness.toggle.checked, true);
  assert.equal(harness.toggle.disabled, false);
  assert.equal(harness.background.inert, false);
});

test('auto approval failure preserves state and researcher role cannot open a change', async () => {
  const harness = approvalSetup();
  harness.context.aiUsRequest = () => Promise.reject(new Error('save failed'));
  harness.context.openAutoApprovalDialog(true);
  await harness.ids.autoApprovalYes.listeners.click();
  assert.equal(harness.toggle.checked, false);
  assert.equal(harness.ids.autoApprovalMessage.textContent, 'save failed');
  assert.equal(harness.ids.autoApprovalClose.hidden, false);
  harness.ids.autoApprovalClose.listeners.click();
  assert.equal(harness.toggle.disabled, false);
  const readonly = approvalSetup('researcher');
  readonly.context.openAutoApprovalDialog(true);
  assert.equal(readonly.context.autoApprovalPending, null);
  assert.equal(readonly.toggle.disabled, true);
});

function admissionSetup(role = 'admin') {
  const harness = approvalSetup(role);
  const element = () => ({ listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, focus() {} });
  const body = element(), refresh = element(), message = element(), navigation = element();
  let markup = '', controls = [];
  Object.defineProperty(body, 'innerHTML', {
    get: () => markup,
    set(value) {
      markup = value;
      controls = [...value.matchAll(/<input id="(round(?:Open|Ended))(\d)"([^>]*)>/g)].map(match => Object.assign(element(), {
        id: match[1] + match[2], dataset: { round: match[2], roundSetting: match[1] === 'roundOpen' ? 'isOpen' : 'periodEnded' }, checked: /\bchecked\b/.test(match[3]), disabled: /\bdisabled\b/.test(match[3]),
      }));
      for (const match of value.matchAll(/<select id="roundConfig(\d)"([^>]*)>([\s\S]*?)<\/select>/g)) {
        const selected = match[3].match(/<option value="([^"]*)"[^>]* selected/);
        controls.push(Object.assign(element(), { id: 'roundConfig' + match[1], dataset: { round: match[1], roundSetting: 'configurationId' }, value: selected ? selected[1] : '', disabled: /\bdisabled\b/.test(match[2]) }));
      }
    },
  });
  body.querySelectorAll = () => controls;
  const originalGet = harness.context.document.getElementById;
  harness.context.document.getElementById = id => ({ roundSettingsBody: body, roundSettingsRefresh: refresh, roundSettingsMessage: message }[id] || controls.find(control => control.id === id) || originalGet(id));
  harness.context.document.querySelector = () => navigation;
  harness.context.sessionStorage = { getItem: () => role };
  const records = [1, 2, 3, 4].map(round => ({ surveyRound: round, isOpen: round === 2, submissionAllowed: round === 2, periodEnded: round === 1, state: round === 1 ? 'closed' : round === 2 ? 'open' : 'preparing', configurationId: round < 3 ? 'release' : null, configurations: round < 3 ? [{ id: 'release', label: '공통 파트 1·2', versions: [{ surveyVersion: 'part1' }, { surveyVersion: 'part2' }] }] : [], updatedAt: null, updatedBy: null }));
  harness.context.aiUsRequest = (requestPath, options) => {
    harness.calls.push({ path: requestPath, options });
    if (!options) return Promise.resolve(records.map(record => ({ ...record })));
    const record = records.find(item => requestPath.endsWith('/' + item.surveyRound));
    if ('isOpen' in options.body) record.submissionAllowed = options.body.isOpen;
    if ('configurationId' in options.body) record.configurationId = options.body.configurationId;
    if ('periodEnded' in options.body) { record.periodEnded = options.body.periodEnded; record.submissionAllowed = false; }
    record.state = !record.configurationId ? 'preparing' : record.periodEnded ? 'closed' : record.submissionAllowed ? 'open' : 'preparing';
    record.isOpen = record.state === 'open';
    return Promise.resolve({ ...record, updatedAt: '2026-01-01T00:00:00Z', updatedBy: '<admin>' });
  };
  vm.runInContext(script.slice(script.indexOf('  function initSurveyRoundSettings(){'), script.indexOf('\n  initSurveyRoundSettings();')), harness.context);
  harness.context.initSurveyRoundSettings();
  return Object.assign(harness, { body, refresh, message, navigation, records, controls: () => controls, control: id => controls.find(control => control.id === id), toggles: () => controls.filter(control => control.dataset.roundSetting === 'isOpen'), writes: () => harness.calls.filter(call => call.options) });
}

test('round admission loads four rounds and cancel preserves saved state without writes', async () => {
  const names = [...html.matchAll(/<button[^>]*data-panel="([^"]+)"/g)].map(match => match[1]);
  const panels = Object.fromEntries(names.map(name => [name, { on: false, classList: { toggle(unused, active) { panels[name].on = active; } } }]));
  const buttons = names.map(name => ({ dataset: { panel: name }, classList: { add() {}, remove() {} }, addEventListener(unused, listener) { this.click = listener; } }));
  vm.runInNewContext('(function(){' + script.slice(script.indexOf('    var btns=document.querySelectorAll(\'#side button\');'), script.indexOf('  // ---- abuse review ----')), {
    Event: class { constructor(type) { this.type = type; } },
    document: { querySelectorAll: () => buttons, getElementById: id => panels[id.replace('panel-', '')], dispatchEvent: event => assert.equal(event.type, 'ai-us-panel-change') },
  });
  buttons.find(button => button.dataset.panel === 'admission').click();
  assert.deepEqual(names.filter(name => panels[name].on), ['admission']);
  assert.ok(html.indexOf('data-panel="absent"') < html.indexOf('data-panel="admission"'));
  assert.ok(html.indexOf('data-panel="admission"') < html.indexOf('data-panel="files"'));
  const harness = admissionSetup();
  await harness.navigation.listeners.click();
  assert.equal(harness.calls[0].path, '/api/v1/researcher/survey-round-settings');
  assert.deepEqual(harness.toggles().map(toggle => toggle.checked), [false, true, false, false]);
  const toggle = harness.toggles()[1]; toggle.checked = false; toggle.listeners.change();
  assert.equal(toggle.checked, true);
  assert.ok(harness.toggles().every(input => input.disabled));
  assert.match(harness.ids.autoApprovalTitle.textContent, /2회차.*중지/);
  harness.ids.autoApprovalNo.listeners.click();
  assert.equal(harness.writes().length, 0);
  assert.equal(harness.toggles()[1].checked, true);
  assert.equal(harness.toggles()[1].disabled, false);
  assert.ok(harness.controls().filter(control => Number(control.dataset.round) > 2).every(control => control.disabled));
});

test('round admission saves only selected round once and renders server audit safely', async () => {
  const harness = admissionSetup();
  await harness.refresh.listeners.click();
  let finish;
  harness.context.aiUsRequest = (requestPath, options) => {
    harness.calls.push({ path: requestPath, options });
    return new Promise(resolve => { finish = resolve; });
  };
  const toggle = harness.toggles()[1]; toggle.checked = false; toggle.listeners.change();
  const pending = harness.ids.autoApprovalYes.listeners.click();
  harness.ids.autoApprovalYes.listeners.click();
  harness.ids.autoApprovalDialog.listeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(harness.writes().length, 1);
  assert.equal(harness.writes()[0].path, '/api/v1/admin/survey-round-settings/2');
  assert.equal(harness.writes()[0].options.body.isOpen, false);
  assert.equal(harness.writes()[0].options.localErrorDialog, true);
  assert.equal(harness.toggles()[1].checked, true);
  assert.equal(harness.refresh.disabled, true);
  finish({ ...harness.records[1], isOpen: false, submissionAllowed: false, state: 'preparing', updatedAt: '2026-01-01T00:00:00Z', updatedBy: '<admin>' });
  await pending;
  assert.deepEqual(harness.toggles().map(input => input.checked), [false, false, false, false]);
  assert.match(harness.body.innerHTML, /&lt;admin&gt;/);
  assert.doesNotMatch(harness.body.innerHTML, /<admin>/);
  assert.equal(harness.refresh.disabled, false);
});

test('round admission failure preserves state, fetch failure locks controls, researcher is read only', async () => {
  const harness = admissionSetup();
  await harness.refresh.listeners.click();
  harness.context.aiUsRequest = () => Promise.reject(new Error('save failed'));
  const toggle = harness.toggles()[1]; toggle.checked = false; toggle.listeners.change();
  await harness.ids.autoApprovalYes.listeners.click();
  assert.equal(harness.toggles()[1].checked, true);
  assert.equal(harness.ids.autoApprovalMessage.textContent, 'save failed');
  assert.equal(harness.ids.autoApprovalClose.hidden, false);
  harness.ids.autoApprovalClose.listeners.click();
  await harness.refresh.listeners.click();
  assert.ok(harness.toggles().every(input => input.disabled));
  assert.equal(harness.message.textContent, 'save failed');
  const readonly = admissionSetup('researcher');
  await readonly.refresh.listeners.click();
  assert.ok(readonly.toggles().every(input => input.disabled));
  const forged = readonly.toggles()[1]; forged.checked = false; forged.listeners.change();
  assert.equal(forged.checked, true);
  assert.equal(readonly.context.approvalChange, null);
  assert.equal(readonly.writes().length, 0);
});

test('configuration and period controls confirm, preserve cancelled selection and never auto resume', async () => {
  const harness = admissionSetup();
  await harness.refresh.listeners.click();
  assert.match(html, /<th>회차 상태<\/th><th>설문 구성<\/th><th>제출 허용<\/th><th>설문기간 종료<\/th>/);
  const selection = harness.control('roundConfig2'); selection.value = ''; selection.listeners.change();
  assert.equal(selection.value, 'release');
  harness.ids.autoApprovalNo.listeners.click();
  assert.equal(harness.writes().length, 0);
  let control = harness.control('roundEnded2'); control.checked = true; control.listeners.change();
  assert.match(harness.ids.autoApprovalMessage.textContent, /제출 허용도 함께/);
  await harness.ids.autoApprovalYes.listeners.click();
  assert.equal(harness.control('roundOpen2').checked, false);
  assert.equal(harness.control('roundOpen2').disabled, true);
  assert.equal(harness.control('roundEnded2').checked, true);
  control = harness.control('roundEnded2'); control.checked = false; control.listeners.change();
  assert.match(harness.ids.autoApprovalMessage.textContent, /자동 재개되지/);
  await harness.ids.autoApprovalYes.listeners.click();
  assert.equal(harness.control('roundOpen2').checked, false);
  assert.equal(harness.control('roundOpen2').disabled, false);
  control = harness.control('roundConfig2'); control.value = ''; control.listeners.change();
  await harness.ids.autoApprovalYes.listeners.click();
  assert.equal(harness.control('roundConfig2').value, '');
  assert.equal(harness.control('roundOpen2').disabled, true);
  assert.equal(harness.control('roundEnded2').disabled, true);
  assert.equal(harness.control('roundConfig2').disabled, false);
  assert.equal(harness.writes().at ? harness.writes().at(-1).options.body.configurationId : harness.writes()[harness.writes().length-1].options.body.configurationId, null);
});

test('local error dialog prevents duplicate global error popup without changing other requests', async () => {
  for (const localErrorDialog of [true, false]) {
    let alerts = 0;
    const context = vm.createContext({
      AI_US_ACCESS_TOKEN: 'test-only', AI_US_API_BASE: 'https://api.invalid', FormData: class {},
      sessionStorage: { removeItem() {} }, window: { location: {} },
      aiUsShowTemporaryIssue() { alerts++; },
      fetch: async (url, options) => {
        assert.equal('localErrorDialog' in options, false);
        return { status: 503, ok: false, json: async () => ({ detail: 'unavailable' }) };
      },
    });
    vm.runInContext(script.slice(script.indexOf('  function aiUsRequest('), script.indexOf('  function aiUsShowTemporaryIssue(')), context);
    await assert.rejects(context.aiUsRequest('/api/v1/admin/application-settings', { localErrorDialog }), /unavailable/);
    assert.equal(alerts, localErrorDialog ? 0 : 1);
  }
});

function analysisSetup() {
  const timers = new Map(), calls = [], listeners = {};
  let nextTimer = 0;
  const context = vm.createContext({
    Promise, Map, Date, URLSearchParams, AbortController,
    document: { hidden: false, getElementById: () => null, addEventListener(name, callback) { listeners[name] = callback; } },
    setTimeout(callback, delay) {
      if (delay === 1000) { queueMicrotask(callback); return 0; }
      timers.set(++nextTimer, callback); return nextTimer;
    },
    clearTimeout(id) { timers.delete(id); },
    aiUsRequest(requestPath, options) { calls.push({ path: requestPath, options }); return Promise.reject(new Error('Unexpected request')); },
  });
  vm.runInContext(script.slice(script.indexOf('  function aiUsPanelVisible('), script.indexOf('  // ---- manage sidebar ----')), context);
  return { context, timers, calls, listeners };
}

test('analysis and activity do not load until the visible menu is opened', () => {
  const harness = analysisSetup();
  let visible = false, loads = 0;
  harness.context.document.getElementById = () => ({ classList: { contains: () => visible }, closest: () => ({ classList: { contains: () => true } }) });
  harness.context.aiUsOnPanelOpen('abuse', () => loads++);
  assert.equal(loads, 0);
  harness.listeners['ai-us-panel-change']();
  assert.equal(loads, 0);
  visible = true;
  harness.listeners['ai-us-panel-change']();
  harness.listeners['ai-us-panel-change']();
  assert.equal(loads, 1);
  assert.ok(script.includes("aiUsOnPanelOpen('abuse',loadDefinitions)"));
  assert.ok(script.includes("aiUsOnPanelOpen('activity',load,true)"));
  harness.context.document.hidden = true;
  assert.equal(harness.context.aiUsPanelVisible('activity'), false);
});

test('analysis poll retry reuses its known job and cleans request timers', async () => {
  const harness = analysisSetup();
  let posts = 0, polls = 0;
  harness.context.aiUsRequest = async (requestPath, options) => {
    assert.equal(options.localErrorDialog, true);
    if (options.method === 'POST') { posts++; return { jobId: 'analysis-1', status: 'queued' }; }
    assert.ok(requestPath.includes('/jobs/analysis-1'));
    polls++;
    if (polls === 1) throw new Error('connection lost');
    return polls === 2 ? { status: 'processing' } : { status: 'completed', result: { totalResponses: 142 } };
  };
  const query = '?survey_round=1&survey_version=v2&pair_page_size=200';
  await assert.rejects(harness.context.aiUsWaitForAnalysis(query), /connection lost/);
  assert.equal(harness.context.AI_US_ANALYSIS_JOBS.size, 1);
  const states = [];
  const result = await harness.context.aiUsWaitForAnalysis(query, state => states.push(state));
  assert.equal(result.totalResponses, 142);
  assert.deepEqual(states, ['processing', 'completed']);
  assert.equal(posts, 1);
  assert.equal(harness.context.AI_US_ANALYSIS_JOBS.size, 0);
  assert.equal(harness.timers.size, 0);
});

test('failed analysis permits explicit re-request and request timeout aborts cleanly', async () => {
  const harness = analysisSetup();
  let posts = 0;
  harness.context.aiUsRequest = async (requestPath, options) => options.method === 'POST' ? { jobId: 'job-' + ++posts } : { status: 'failed', error: 'analysis failed' };
  const query = '?survey_round=1&survey_version=v2';
  await assert.rejects(harness.context.aiUsWaitForAnalysis(query), /analysis failed/);
  assert.equal(harness.context.AI_US_ANALYSIS_JOBS.size, 0);
  await assert.rejects(harness.context.aiUsWaitForAnalysis(query), /analysis failed/);
  assert.equal(posts, 2);
  harness.context.aiUsRequest = (requestPath, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = harness.context.aiUsAnalysisRequest('/pending');
  assert.equal(harness.timers.size, 1);
  [...harness.timers.values()][0]();
  await assert.rejects(pending, /aborted/);
  assert.equal(harness.timers.size, 0);
});

test('analysis polling has a total deadline and retains the job for later observation', async () => {
  const harness = analysisSetup();
  let clockReads = 0;
  harness.context.Date = { now: () => clockReads++ === 0 ? 0 : 600001 };
  harness.context.aiUsRequest = async () => ({ jobId: 'still-running' });
  await assert.rejects(harness.context.aiUsWaitForAnalysis('?survey_round=1&survey_version=v2'), /계속 진행 중/);
  assert.equal(harness.context.AI_US_ANALYSIS_JOBS.size, 1);
  assert.equal(harness.timers.size, 0);
});

test('explicit analysis refresh is forwarded and missing jobs can be requested again', async () => {
  const harness = analysisSetup();
  let posts = 0;
  harness.context.aiUsRequest = async (requestPath, options) => {
    if (options.method === 'POST') {
      posts++;
      assert.ok(requestPath.includes('refresh=true'));
      return { jobId: 'missing' };
    }
    const error = new Error('not found'); error.status = 404; throw error;
  };
  const query = '?survey_round=1&survey_version=v2&refresh=true';
  await assert.rejects(harness.context.aiUsWaitForAnalysis(query), /not found/);
  assert.equal(harness.context.AI_US_ANALYSIS_JOBS.size, 0);
  await assert.rejects(harness.context.aiUsWaitForAnalysis(query), /not found/);
  assert.equal(posts, 2);
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