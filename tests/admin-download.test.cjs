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
  assert.equal((script.match(/runAdminDownload\(/g) || []).length, 13);
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

test('consent styling bounds history scrolling and reuses the console modal theme', () => {
  const consentPosition = html.indexOf('<section id="chatConsentSection"');
  assert.ok(consentPosition > html.indexOf('id="panel-consent"'));
  assert.ok(consentPosition < html.indexOf('id="panel-absent"'));
  assert.ok(html.indexOf('data-panel="status"') < html.indexOf('data-panel="consent"'));
  assert.ok(html.indexOf('data-panel="consent"') < html.indexOf('data-panel="absent"'));
  assert.match(html, /id="chatConsentSection" class="card consent-section"/);
  assert.match(script, /openChatConsent=function\(value\)[\s\S]*?querySelector\('#side \[data-panel="consent"\]'\)/);
  assert.match(html, /\.consent-history\{[^}]*max-height:240px;overflow:auto/);
  assert.match(html, /\.manage \.tbl-wrap\.consent-history table\{min-width:920px\}/);
  assert.match(html, /\.consent-history th\{position:sticky;top:0/);
  assert.match(html, /class="tbl-wrap consent-history"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(html, /id="chatConsentConfirm" class="server-modal consent-confirm"/);
  assert.match(html, /class="fgroup consent-reason"/);
  assert.match(html, /\.consent-section \[hidden\]\{display:none!important\}/);
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

test('consent-invalidated ZIP is cleared without automatic mutation retry', async () => {
  const harness = setup();
  let posts = 0, restricted = true;
  harness.context.fetch = async (url, options) => {
    if (options.method === 'POST') { posts++; return jsonResponse({ jobId: 'stale' }); }
    if (url.endsWith('/jobs/stale')) return jsonResponse({ status: 'completed', downloadUrl: '/file' });
    if (restricted) return { ok: false, status: 409, json: async () => ({ detail: '자료 이용 상태가 변경되었습니다.' }) };
    return { ok: true, status: 200, headers: { get: () => '' }, blob: async () => ({}) };
  };
  await assert.rejects(harness.context.downloadAdminArchive('/jobs', {}, 'out.zip'), /자료 이용 상태/);
  assert.equal(posts, 1);
  assert.equal(harness.context.adminDownloadJobs.size, 0);
  assert.equal(harness.downloads(), 0);
  restricted = false;
  await harness.context.downloadAdminArchive('/jobs', {}, 'out.zip');
  assert.equal(posts, 2);
  assert.equal(harness.downloads(), 1);
});

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
  buttons.find(button => button.dataset.panel === 'consent').click();
  assert.deepEqual(names.filter(name => panels[name].on), ['consent']);
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

function pauseSetup(role = 'admin') {
  const harness = approvalSetup(role);
  const element = () => ({ listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, focus() {} });
  const toggle = element(), status = element(), audit = element(), refresh = element(), navigation = element();
  const originalGet = harness.context.document.getElementById;
  harness.context.document.getElementById = id => ({ participationPauseToggle: toggle, participationPauseStatus: status, participationPauseAudit: audit, roundSettingsRefresh: refresh }[id] || originalGet(id));
  harness.context.document.querySelector = () => navigation;
  harness.context.sessionStorage = { getItem: () => role };
  harness.context.aiUsRequest = (path, options) => {
    harness.calls.push({ path, options });
    return Promise.resolve({ participationPaused: options.method === 'PUT' ? options.body.participationPaused : false, updatedAt: '2026-11-05T00:00:00Z', updatedBy: '<admin>' });
  };
  vm.runInContext(script.slice(script.indexOf('  function initParticipationSettings(){'), script.indexOf('  function initSurveyRoundSettings(){')), harness.context);
  harness.context.initParticipationSettings();
  return Object.assign(harness, { pauseToggle: toggle, pauseStatus: status, audit, refresh, navigation, writes: () => harness.calls.filter(call => call.options.method === 'PUT') });
}

test('global pause confirms cancel and saves once with busy dismissal blocked', async () => {
  const harness = pauseSetup();
  assert.equal(harness.pauseToggle.disabled, true);
  await harness.navigation.listeners.click();
  assert.equal(harness.pauseToggle.disabled, false);
  harness.pauseToggle.checked = true; harness.pauseToggle.listeners.change();
  assert.equal(harness.pauseToggle.checked, false);
  harness.ids.autoApprovalNo.listeners.click();
  assert.equal(harness.writes().length, 0);
  harness.pauseToggle.checked = true; harness.pauseToggle.listeners.change();
  let finish;
  harness.context.aiUsRequest = (path, options) => { harness.calls.push({ path, options }); return new Promise(resolve => { finish = resolve; }); };
  const pending = harness.ids.autoApprovalYes.listeners.click();
  harness.ids.autoApprovalYes.listeners.click();
  harness.ids.autoApprovalDialog.listeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(harness.writes().length, 1);
  assert.equal(harness.writes()[0].path, '/api/v1/admin/participation-settings');
  assert.equal(harness.writes()[0].options.body.participationPaused, true);
  assert.equal(harness.pauseToggle.disabled, true);
  finish({ participationPaused: true, updatedAt: '2026-11-05T00:00:00Z', updatedBy: '<admin>' });
  await pending;
  assert.equal(harness.pauseToggle.checked, true);
  assert.equal(harness.pauseToggle.disabled, false);
  assert.match(harness.audit.textContent, /<admin>/);
  assert.match(harness.pauseStatus.textContent, /중단 중/);
  harness.pauseToggle.checked = false; harness.pauseToggle.listeners.change();
  assert.match(harness.ids.autoApprovalMessage.textContent, /회차별.*변경되지/);
  harness.ids.autoApprovalNo.listeners.click();
  assert.equal(harness.pauseToggle.checked, true);
});

test('global pause failed save requires fresh read and researchers cannot mutate', async () => {
  const harness = pauseSetup();
  await harness.refresh.listeners.click();
  harness.context.aiUsRequest = () => Promise.reject(new Error('uncertain save'));
  harness.pauseToggle.checked = true; harness.pauseToggle.listeners.change();
  await harness.ids.autoApprovalYes.listeners.click();
  harness.ids.autoApprovalClose.listeners.click();
  assert.equal(harness.pauseToggle.checked, false);
  assert.equal(harness.pauseToggle.disabled, true);
  await harness.refresh.listeners.click();
  assert.equal(harness.audit.textContent, 'uncertain save');
  const readonly = pauseSetup('researcher');
  await readonly.navigation.listeners.click();
  assert.equal(readonly.pauseToggle.disabled, true);
  readonly.pauseToggle.checked = true; readonly.pauseToggle.listeners.change();
  assert.equal(readonly.pauseToggle.checked, false);
  assert.equal(readonly.writes().length, 0);
  assert.equal(readonly.context.approvalChange, null);
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

function consentSetup() {
  const calls = [], timers = new Map(), events = [];
  let timerId = 0;
  const ids = {};
  for (const match of html.matchAll(/id="(chatConsent[^"]*)"/g)) {
    ids[match[1]] = {
      value: '', checked: false, disabled: false, hidden: false, textContent: '', innerHTML: '', listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      dispatchEvent(event) { return this.listeners[event.type](event); },
      focus() {}, scrollIntoView() {},
      showModal() { this.open = true; },
      close() { this.open = false; if (this.listeners.close) this.listeners.close(); },
    };
  }
  const state = { account: { participantId: 'csv-only', phone: '01012345678', name: null, schoolLevel: '초등', grade: 4, chatConsent: true, revision: 0, submissionCount: 2, restrictedSubmissionCount: 0, restrictedBefore: null, history: [] } };
  const context = vm.createContext({
    document: { getElementById: id => ids[id], querySelector: () => ({ click() {} }) },
    window: { dispatchEvent: event => events.push(event.type) },
    Event: class { constructor(type) { this.type = type; } preventDefault() {} },
    AbortController: class { constructor() { this.signal = {}; } abort() { this.signal.aborted = true; } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    adminDownloadBusy: false, adminDownloadErrorOpen: false,
    esc: value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    formatKstDate: value => value,
    formatKstDateTime: value => value,
    updateAdminDownload() {},
    aiUsRequest(requestPath, options) {
      calls.push({ path: requestPath, options });
      if (state.handler) return state.handler(requestPath, options);
      if (options.method === 'PUT') {
        state.account = Object.assign({}, state.account, { chatConsent: options.body.chatConsent, revision: state.account.revision + 1, restrictedBefore: options.body.restoreExisting ? null : '2026-10-30T00:00:00Z' });
      }
      return Promise.resolve(JSON.parse(JSON.stringify(state.account)));
    },
    runAdminDownload(button, title, task, errorTitle) {
      context.adminDownloadBusy = true;
      return Promise.resolve().then(task).catch(error => { state.error = error; state.errorTitle = errorTitle; return false; }).finally(() => { context.adminDownloadBusy = false; });
    },
  });
  const start = script.indexOf('  var openChatConsent;');
  vm.runInContext(script.slice(start, script.indexOf('  // ---- AI 대화문 다운로드 ----', start)), context);
  const emit = (id, name = 'click') => ids[id].listeners[name]({ preventDefault() {} });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function lookup() { ids.chatConsentPhone.value = '010-1234-5678'; emit('chatConsentLookup', 'submit'); await flush(); }
  return { ids, state, context, calls, timers, events, emit, flush, lookup };
}

test('consent results group account identity with status and include escaped participant details in history', async () => {
  const harness = consentSetup();
  await harness.lookup();
  assert.match(html, /<legend>조회 결과<\/legend>\s*<div class="consent-summary"><strong id="chatConsentIdentity"><\/strong><p id="chatConsentMaterialStatus"/);
  assert.equal(harness.ids.chatConsentIdentity.textContent, '01012345678 · 초등 · 4학년');
  assert.match(harness.ids.chatConsentMaterialStatus.textContent, /현재 동의: 동의 · 제출 2건 · 숨김 0건/);
  assert.match(harness.ids.chatConsentHistory.innerHTML, /colspan="6"/);
  Object.assign(harness.state.account, { name: '<img src=x>', history: [{ updatedAt: 'today', updatedBy: 'researcher', reason: '요청', previousConsent: true, chatConsent: false }] });
  await harness.lookup();
  assert.match(harness.ids.chatConsentHistory.innerHTML, /class="consent-participant">01012345678 · &lt;img src=x> · 초등 · 4학년<\/td>/);
  assert.ok(!harness.ids.chatConsentHistory.innerHTML.includes('<img'));
});

test('consent lookup locks duplicate requests, normalizes exact phone and cancellation writes nothing', async () => {
  const harness = consentSetup();
  harness.ids.chatConsentPhone.value = '010-1234-5678';
  harness.emit('chatConsentLookup', 'submit'); harness.emit('chatConsentLookup', 'submit');
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].options.body.phone, '01012345678');
  assert.equal(harness.ids.chatConsentSearch.disabled, true);
  await harness.flush();
  assert.equal(harness.ids.chatConsentSearch.disabled, false);
  assert.equal(harness.timers.size, 0);
  harness.ids.chatConsentEnabled.checked = false; harness.emit('chatConsentEnabled', 'change');
  harness.emit('chatConsentSave');
  assert.equal(harness.ids.chatConsentConfirm.open, undefined);
  harness.ids.chatConsentReason.value = '본인 연락으로 철회'; harness.emit('chatConsentSave');
  assert.equal(harness.ids.chatConsentConfirm.open, true);
  assert.match(harness.ids.chatConsentConfirmMessage.textContent, /2건 숨김.*원본 보존/);
  harness.emit('chatConsentConfirmNo');
  assert.equal(harness.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.equal(harness.ids.chatConsentResult.disabled, false);
});

test('consent saves once after confirmation and preserves scope and audited revision', async () => {
  const harness = consentSetup(); await harness.lookup();
  harness.ids.chatConsentEnabled.checked = false; harness.emit('chatConsentEnabled', 'change');
  harness.ids.chatConsentReason.value = '철회 요청'; harness.emit('chatConsentSave');
  let resolveSave;
  harness.state.handler = (requestPath, options) => new Promise(resolve => { resolveSave = resolve; });
  harness.emit('chatConsentConfirmYes'); harness.emit('chatConsentConfirmYes');
  await harness.flush();
  const writes = harness.calls.filter(call => call.options.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.body.expectedRevision, 0);
  assert.equal(writes[0].options.body.restoreExisting, false);
  assert.equal(harness.ids.chatConsentResult.disabled, true);
  resolveSave(Object.assign({}, harness.state.account, { chatConsent: false, revision: 1, restrictedBefore: '2026-10-30T00:00:00Z', restrictedSubmissionCount: 2 }));
  await harness.flush();
  assert.equal(harness.ids.chatConsentEnabled.checked, false);
  assert.equal(harness.ids.chatConsentResult.disabled, false);
  assert.deepEqual(harness.events, ['ai-us-chat-consent-changed']);
});

test('consent failure requires fresh lookup and old materials restore only by explicit selection', async () => {
  const harness = consentSetup();
  Object.assign(harness.state.account, { chatConsent: false, revision: 2, restrictedBefore: '2026-10-30T00:00:00Z', restrictedSubmissionCount: 2, history: [{ updatedAt: 'today', updatedBy: 'researcher', reason: '<script>unsafe</script>', previousConsent: true, chatConsent: false }] });
  await harness.lookup();
  assert.ok(harness.ids.chatConsentHistory.innerHTML.includes('&lt;script>'));
  harness.ids.chatConsentEnabled.checked = true; harness.emit('chatConsentEnabled', 'change');
  assert.equal(harness.ids.chatConsentRestore.checked, false);
  harness.ids.chatConsentRestore.checked = true; harness.emit('chatConsentRestore', 'change');
  harness.ids.chatConsentReason.value = '기존 자료 복원 요청'; harness.emit('chatConsentSave');
  assert.match(harness.ids.chatConsentConfirmMessage.textContent, /2건 복원/);
  harness.state.handler = async () => { throw new Error('unknown outcome'); };
  harness.emit('chatConsentConfirmYes'); await harness.flush();
  const writes = harness.calls.filter(call => call.options.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.body.restoreExisting, true);
  assert.equal(writes[0].options.body.expectedRevision, 2);
  assert.equal(harness.ids.chatConsentResult.hidden, true);
  assert.equal(harness.ids.chatConsentSave.disabled, true);
  harness.emit('chatConsentSave');
  assert.equal(harness.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.match(harness.ids.chatConsentFeedback.textContent, /다시 조회/);
  assert.equal(harness.timers.size, 0);
});

function parseSetup(records, state, conflict = false) {
  const calls = [];
  const button = { dataset: { id: 'source' }, disabled: false, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; } };
  const status = {};
  const csv = { removed: false, remove() { this.removed = true; } };
  const actions = {
    querySelectorAll: () => [csv], querySelector: () => csv.removed ? null : csv,
    insertAdjacentHTML() { csv.removed = false; },
  };
  let markup = '';
  const body = {
    querySelectorAll: selector => selector === '.transcript-parse' && markup.includes('transcript-parse') ? [button] : [],
    querySelector: selector => selector.includes('.download-actions') ? actions : selector.includes('.transcript-status') ? status : button,
  };
  Object.defineProperty(body, 'innerHTML', {
    get: () => markup,
    set(value) { markup = value; button.disabled = value.includes('disabled>오류 파일'); },
  });
  const context = vm.createContext({
    cBody: body, Promise,
    previewCache: new Map(), previewPending: new Map(), previewCacheEpoch: 0, previewCacheToken: 'synthetic', AI_US_ACCESS_TOKEN: 'synthetic',
    chatRenderedPage: 1, chatRenderedFilter: null, chatRetryPage: 1,
    AbortController, clearTimeout() {},
    chatPage: 1, chatTotal: 0, chatPageSize: 100, previewRequest: 0, chatLoading: false, chatLoadError: false, chatLegacy: false,
    selectedSubmissionIds: new Set(), selectAllFiltered: false, renderChatPagination() {},
    filterParams: () => new URLSearchParams(), updateSelectionSummary() {},
    esc: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    pointLabel: value => value, formatKstDate: value => value, sourceTag: value => value,
    compactFilename: value => value, reviewControl: () => '',
    setTimeout(callback, delay) { if(delay===10000)return 0;if(delay===800||delay===2000){queueMicrotask(callback);return 0;}throw new Error('Unexpected timer: '+delay); },
    aiUsRequest(path, options) {
      calls.push({ path, options });
      if (path.includes('chat-submission-previews')) return typeof records === 'function' ? records(path, options) : Promise.resolve(records);
      if (path.includes('parse-runs')) return typeof state === 'function' ? state() : Promise.resolve(state);
      if (conflict) {
        records = records.map(record => ({ ...record, parseStatus: 'invalid_source', parseError: '다른 서비스 export' }));
        return Promise.reject(Object.assign(new Error('다른 서비스 export'), { status: 409 }));
      }
      return Promise.resolve({ runId: 'run' });
    },
  });
  vm.runInContext(
    script.slice(script.indexOf('    function invalidateChatPreviewCache('), script.indexOf('    function selectedIds(')) +
    script.slice(script.indexOf('    function showCompletedParse('), script.indexOf('    function compactFilename(')) +
    script.slice(script.indexOf('    function loadPreview(propagateError)'), script.indexOf('    function upd(){selectAllFiltered=')), context);
  return { context, button, status, csv, body, calls, setRecords(value, invalidate = true) { records = value; if(invalidate)context.invalidateChatPreviewCache(); } };
}

const parseRecord = { submissionId: 'source', filenames: ['takeout.zip'], attachmentCount: 1, sourceType: 'file', parseStatus: 'placeholder' };
const flushParse = () => new Promise(resolve => setImmediate(resolve));

test('chat pagination requests older pages and preserves selected rows', async () => {
  const envelope = { items: [parseRecord], total: 205, page: 2, pageSize: 100 };
  const harness = parseSetup(envelope, {});
  harness.context.chatPage = 2;
  harness.context.selectedSubmissionIds.add('source');
  await harness.context.loadPreview();
  assert.match(harness.calls[0].path, /[?&]page=2(?:&|$)/);
  assert.equal(harness.calls[0].options.localErrorDialog, true);
  assert.equal(harness.context.chatTotal, 205);
  assert.equal(harness.context.chatPage, 2);
  assert.match(harness.body.innerHTML, /type="checkbox" checked value="source"/);
  harness.setRecords({ items: [], total: 0, page: 1, pageSize: 100 });
  await harness.context.loadPreview();
  assert.equal(harness.context.chatPage, 1);
  assert.equal(harness.context.chatTotal, 0);
});

test('chat pagination ignores stale filtered responses', async () => {
  let finishOld;
  const harness = parseSetup(new Promise(resolve => { finishOld = resolve; }), {});
  const old = harness.context.loadPreview();
  harness.setRecords({ items: [], total: 0, page: 1, pageSize: 100 });
  await harness.context.loadPreview();
  finishOld({ items: [parseRecord], total: 205, page: 2, pageSize: 100 });
  await old;
  assert.equal(harness.context.chatTotal, 0);
  assert.equal(harness.context.chatPage, 1);
  assert.equal(harness.body.innerHTML.includes('value="source"'), false);
});

test('chat preview cache reuses fresh pages, expires and isolates login sessions', async () => {
  const harness = parseSetup({ items: [parseRecord], total: 205, page: 1, pageSize: 100 }, {});
  await harness.context.loadPreview();
  await harness.context.loadPreview();
  assert.equal(harness.calls.length, 1);
  harness.setRecords({ items: [], total: 0, page: 1, pageSize: 100 }, false);
  await harness.context.loadPreview();
  assert.equal(harness.context.chatTotal, 205);
  for (const cached of harness.context.previewCache.values()) cached.expiresAt = 0;
  await harness.context.loadPreview();
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.context.chatTotal, 0);
  harness.context.AI_US_ACCESS_TOKEN = 'another-synthetic-session';
  await harness.context.loadPreview();
  assert.equal(harness.calls.length, 3);
  harness.context.invalidateChatPreviewCache();
  await harness.context.loadPreview();
  assert.equal(harness.calls.length, 4);
});

test('identical in-flight page reads are shared and cache stays bounded', async () => {
  let finish;
  const harness = parseSetup(new Promise(resolve => { finish = resolve; }), {});
  const first = harness.context.loadPreview();
  const second = harness.context.loadPreview();
  assert.equal(harness.calls.length, 1);
  finish({ items: [], total: 0, page: 1, pageSize: 100 });
  await Promise.all([first, second]);
  for (let page = 2; page <= 25; page++) {
    harness.setRecords({ items: [], total: 2500, page, pageSize: 100 }, false);
    await harness.context.fetchChatPreview(new URLSearchParams({ page }));
  }
  assert.equal(harness.context.previewCache.size, 20);
});

test('page GET retries temporary failures twice locally but never retries client errors', async () => {
  let reads = 0;
  const harness = parseSetup(() => ++reads < 3
    ? Promise.reject(Object.assign(new Error('synthetic temporary failure'), { status: 502 }))
    : Promise.resolve({ items: [parseRecord], total: 205, page: 3, pageSize: 100 }), {});
  harness.context.chatPage = 3;
  await harness.context.loadPreview();
  assert.equal(reads, 3);
  assert.equal(harness.context.chatLoadError, false);
  assert.ok(harness.calls.every(call => call.options.localErrorDialog === true && call.options.cache === 'no-store' && !call.options.method));
  harness.setRecords(() => Promise.reject(Object.assign(new Error('synthetic bad filter'), { status: 422 })));
  await harness.context.loadPreview();
  assert.equal(harness.calls.length, 4);
  assert.equal(harness.context.chatLoadError, true);
  assert.equal(harness.context.previewCache.size, 0);
});

test('page request timeouts finish after bounded retries without caching failures', async () => {
  const harness = parseSetup((path, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('synthetic timeout'), { name: 'AbortError' })));
  }), {});
  harness.context.setTimeout = callback => { queueMicrotask(callback); return 0; };
  await harness.context.loadPreview();
  assert.equal(harness.calls.length, 3);
  assert.ok(harness.calls.every(call => call.options.signal.aborted));
  assert.equal(harness.context.previewCache.size, 0);
  assert.equal(harness.context.chatLoading, false);
  assert.equal(harness.context.chatLoadError, true);
});

test('failed next page keeps the last valid rows and retries the requested page', async () => {
  const harness = parseSetup({ items: [parseRecord], total: 205, page: 2, pageSize: 100 }, {});
  harness.context.chatPage = 2;
  await harness.context.loadPreview();
  const markup = harness.body.innerHTML;
  harness.setRecords(() => Promise.reject(Object.assign(new Error('synthetic gateway failure'), { status: 503 })));
  harness.context.chatPage = 3;
  await harness.context.loadPreview();
  assert.equal(harness.body.innerHTML, markup);
  assert.equal(harness.context.chatPage, 2);
  assert.equal(harness.context.chatRetryPage, 3);
  assert.equal(harness.context.chatLoadError, true);
  assert.equal(harness.context.previewCache.size, 0);
});

test('authorization failure clears cached and displayed participant metadata without retry', async () => {
  const harness = parseSetup({ items: [parseRecord], total: 205, page: 1, pageSize: 100 }, {});
  await harness.context.loadPreview();
  harness.context.selectedSubmissionIds.add('source');
  harness.setRecords(() => Promise.reject(Object.assign(new Error('synthetic forbidden'), { status: 403 })));
  await harness.context.loadPreview();
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.context.previewCache.size, 0);
  assert.equal(harness.context.selectedSubmissionIds.size, 0);
  assert.equal(harness.body.innerHTML.includes('value="source"'), false);
});

test('chat pagination matches abuse styling and resets filters without limiting whole-filter downloads', () => {
  for (const position of ['Top', 'Bottom']) assert.match(html, new RegExp('id="chatPagination' + position + '" class="abuse-pair-pagination chat-pagination"'));
  assert.match(script, /function upd\(\)\{selectAllFiltered=false;selectedSubmissionIds\.clear\(\);chatPage=1/);
  assert.match(script, /submissionIds:selectAllFiltered\?\[\]:ids/);
  assert.match(script, /if\(!selectAllFiltered&&!ids\.length\)/);
  assert.match(script, /data-chat-page-action="retry"/);
});

test('disabled parse buttons use neutral styling without hover color or motion effects', () => {
  const styles = html.match(/\.chat-preview-table \.transcript-parse:disabled\{([^}]+)\}/)[1];
  for (const declaration of ['background:#f1f3f5', 'color:#6b7280', 'border-color:#d1d5db', 'box-shadow:none', 'transform:none', 'cursor:not-allowed', 'opacity:1']) {
    assert.ok(styles.split(';').includes(declaration), declaration);
  }
});

test('invalid file survives preview reload, escapes its reason and keeps original download only', async () => {
  const harness = parseSetup([{ ...parseRecord, parseStatus: 'invalid_source', parseError: '<img src=x onerror=alert(1)>' }]);
  for (let reload = 0; reload < 2; reload++) {
    await harness.context.loadPreview();
    assert.match(harness.body.innerHTML, /disabled>오류 파일/);
    assert.match(harness.body.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(harness.body.innerHTML, /<img|transcript-json|transcript-csv/);
    assert.match(harness.body.innerHTML, /chat-file-download/);
    harness.button.listeners.click();
  }
  assert.equal(harness.calls.filter(call => call.options?.method === 'POST').length, 0);
});

test('terminal source failure disables parse button and removes parsed downloads without another request', async () => {
  const harness = parseSetup([parseRecord], { status: 'failed', sourceErrorCode: 'wrong_service_export', error: '다른 서비스 export' });
  await harness.context.loadPreview();
  harness.button.listeners.click();
  await flushParse();
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.textContent, '오류 파일');
  assert.equal(harness.status.textContent, '다른 서비스 export');
  assert.equal(harness.csv.removed, true);
  harness.button.listeners.click();
  assert.equal(harness.calls.filter(call => call.options?.method === 'POST').length, 1);
});

test('poll connection failure stays local and resumes the accepted run without another parse request', async () => {
  let reads = 0;
  const timers = [];
  const harness = parseSetup([parseRecord], () => ++reads <= 2
    ? Promise.reject(new Error('Failed to fetch'))
    : Promise.resolve({ status: 'failed', sourceErrorCode: 'wrong_service_export', error: '다른 서비스 export' }));
  harness.context.setTimeout = (callback, delay) => delay === 10000 ? 0 : timers.push(callback);
  await harness.context.loadPreview();
  harness.button.listeners.click();
  await flushParse();
  assert.equal(timers.length, 1);
  timers.shift()();
  await flushParse();
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.textContent, '상태 확인 필요');
  assert.match(harness.status.innerHTML, /상태 다시 확인/);
  harness.button.listeners.click();
  assert.equal(harness.calls.filter(call => call.options?.method === 'POST').length, 1);
  harness.button.aiUsResumeParse();
  await flushParse();
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.textContent, '오류 파일');
  assert.equal(harness.status.textContent, '다른 서비스 export');
  assert.equal(harness.button.aiUsResumeParse, null);
  const requests = harness.calls.filter(call => !call.path.includes('chat-submission-previews'));
  assert.ok(requests.every(call => call.options.localErrorDialog === true));
  assert.equal(requests.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(requests.filter(call => call.path.endsWith('/parse-runs/run')).length, 3);
  assert.equal(timers.length, 0);
});

test('one transient status failure automatically recovers the invalid-source result without a popup or new parse', async () => {
  let reads = 0;
  const timers = [];
  const harness = parseSetup([parseRecord], () => ++reads === 1
    ? Promise.reject(Object.assign(new Error('temporary gateway failure'), { status: 502 }))
    : Promise.resolve({ status: 'failed', sourceErrorCode: 'wrong_service_export', error: '다른 서비스 export' }));
  harness.context.setTimeout = (callback, delay) => delay === 10000 ? 0 : timers.push(callback);
  await harness.context.loadPreview();
  harness.button.listeners.click();
  await flushParse();
  assert.equal(harness.button.disabled, true);
  assert.equal(timers.length, 1);
  timers.shift()();
  await flushParse();
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.textContent, '오류 파일');
  assert.equal(harness.status.textContent, '다른 서비스 export');
  assert.equal(harness.calls.filter(call => call.options?.method === 'POST').length, 1);
  assert.equal(timers.length, 0);
});

test('technical failures and unsupported formats reenable parsing; completed files retain JSON and CSV', async () => {
  for (const state of [{ status: 'failed', error: 'temporary failure' }, { status: 'warning', warnings: ['unsupported format'] }, { status: 'completed' }]) {
    const harness = parseSetup([parseRecord], state);
    await harness.context.loadPreview();
    harness.button.listeners.click();
    await flushParse();
    assert.equal(harness.button.disabled, false);
    assert.notEqual(harness.button.textContent, '오류 파일');
    if (state.status === 'completed') {
      assert.match(harness.status.innerHTML, /transcript-json/);
      assert.equal(harness.csv.removed, false);
    } else assert.match(harness.status.textContent, /파싱 (?:실패|보류)/);
  }
});

test('stale preview refreshes on parse conflict and does not offer a retry for an invalid source', async () => {
  const harness = parseSetup([parseRecord], null, true);
  await harness.context.loadPreview();
  harness.button.listeners.click();
  await flushParse();
  assert.equal(harness.button.disabled, true);
  assert.match(harness.body.innerHTML, /disabled>오류 파일/);
  assert.match(harness.body.innerHTML, /다른 서비스 export/);
  assert.doesNotMatch(harness.body.innerHTML, /transcript-retry/);
  assert.equal(harness.calls.filter(call => call.options?.method === 'POST').length, 1);
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