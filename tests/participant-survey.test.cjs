const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const script = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
const current = script(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
const baseline = script(execFileSync('git', ['show', 'a76a641:index.html'], { cwd: root, encoding: 'utf8' }));
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const tests = [];
function test(name, run) { tests.push({ name, run }); }

function requestContext() {
  const values = new Map();
  const state = { alerts: 0, refreshes: 0, calls: [] };
  const context = vm.createContext({
    FormData: class {}, AI_US_API_BASE: 'https://invalid.test',
    sessionStorage: { getItem: key => values.get(key) || null },
    aiUsShowTemporaryIssue() { state.alerts++; },
    aiUsParticipantTokenExpiresSoon: () => false,
    aiUsMaybeRefreshParticipantSession() { state.refreshes++; return Promise.resolve(true); },
    fetch: async (url, options) => {
      state.calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  vm.runInContext(slice(current, '  function aiUsRequest(', '  function aiUsParticipantTokenExpiresSoon('), context);
  return { context, state, values };
}

function fixture(spec) {
  const selectors = new Map();
  const controls = [];
  let queries = 0;
  function add(selector, properties) {
    const node = Object.assign({ value: '', checked: false, style: {}, querySelectorAll: () => [], getAttribute(name) { return this[name] || null; } }, properties);
    selectors.set(selector, [...(selectors.get(selector) || []), node]);
    controls.push(node);
    return node;
  }
  const questions = spec.scales.reduce((result, scale) => result.concat(scale.questions), []);
  for (const question of questions) {
    add('.q-card[data-key="' + question.key + '"]', { style: { display: '' } });
    if (question.type === 'single' || question.type === 'likert') {
      const options = question.options || Array.from({ length: question.scale.max - question.scale.min + 1 }, (unused, index) => ({ value: question.scale.min + index }));
      options.forEach((option, index) => add('input[name="' + question.key + '"]', { value: String(option.value), checked: index === 0 }));
      for (const condition of [question.detail, question.other]) {
        if (condition) add('[data-field="' + condition.field.key + '"]', { value: condition.field.type === 'number' ? '3' : 'TEST' });
      }
    } else if (question.type === 'number' || question.type === 'text') {
      add('[data-field="' + question.key + '"]', { value: question.type === 'number' ? '16' : 'TEST' });
    } else if (question.type === 'multi') {
      (question.options || []).forEach((option, index) => add('input[data-multi="' + question.key + '"]', { value: String(option.value), checked: index < 2 }));
      if (question.other) add('[data-field="' + question.other.field.key + '"]', { value: 'OTHER' });
    } else if (question.type === 'grid') {
      for (const row of question.rows || []) {
        add('input[name="' + row.key + '"]', { value: String(question.scale.min), checked: true });
        add('input[name="' + row.key + '"]', { value: String(question.scale.max) });
      }
    } else if (question.type === 'rank') {
      for (let slot = 1; slot <= (question.slots || 3); slot++) {
        const node = add('[data-rank="' + question.key + '"]', { value: slot === 1 ? '__other__' : 'TEST-' + slot, 'data-slot': String(slot) });
        selectors.set('select[data-rank="' + question.key + '"]', [...(selectors.get('select[data-rank="' + question.key + '"]') || []), node]);
        add('[data-rank-other="' + question.key + '"][data-slot="' + slot + '"]', { value: 'CUSTOM' });
      }
    } else if (question.type === 'composite') {
      (question.fields || []).forEach((field, index) => {
        add('[data-comp="' + question.key + '"][data-cfield="' + field.key + '"]', { value: field.type === 'select' ? String(index % 3 + 1) : field.type === 'tel' ? '01000000000' : 'TEST' });
        if (field.otherText) add('[data-comp="' + question.key + '"][data-cfield="' + field.otherText.key + '"]', { value: 'CUSTOM' });
      });
    }
  }
  function lookup(selector) {
    queries++;
    const value = selector.match(/\[value="([^"]*)"\]/);
    if (value) return (selectors.get(selector.replace(value[0], '')) || []).filter(node => node.value === value[1]);
    return selector.endsWith(':checked')
      ? (selectors.get(selector.slice(0, -8)) || []).filter(node => node.checked)
      : selectors.get(selector) || [];
  }
  return {
    body: { querySelectorAll: lookup, querySelector: selector => lookup(selector)[0] || null },
    controls, selectors, queryCount: () => queries,
  };
}

function surveyContext(source, spec, dom) {
  const storage = new Map();
  const labels = {};
  const context = vm.createContext({
    SPEC: () => spec, surveyBody: dom.body, Map,
    window: {}, progressContext: null, surveyDraftOwner: 'draft',
    currentPage: 1, dummySubmissionCompleted: false, dummySurveyStatus: {},
    sessionStorage: { getItem: () => 'test-only' },
    localStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) || null },
    draftKey: () => 'draft',
    document: { getElementById: key => labels[key] || (labels[key] = { style: {} }) },
  });
  vm.runInContext(slice(source, '    var surveyElementCache=', '    function renderQuestion(') || '', context);
  if (!context.scaleActive) vm.runInContext(slice(source, '    function scaleActive(', '    function renderQuestion('), context);
  vm.runInContext(slice(source, '    function collectAnswers(', '    function restoreDraft('), context);
  vm.runInContext(slice(source, '    function isQuestionActive(', '    function enforceMultiMax('), context);
  vm.runInContext(slice(source, '    function saveSurveyDraft(', '    function markChoiceSelected('), context);
  return { context, storage, labels };
}

test('inline scripts parse and heartbeat, submission remain unchanged', () => {
  new vm.Script(current);
  for (const [start, end] of [
    ['    function sendSurveyHeartbeat()', '    window.aiUsStartParticipantSession='],
  ]) assert.equal(slice(current, start, end).replace("    if(typeof window!=='undefined'&&window.AI_US_PREVIEW)return Promise.resolve(false);\n", ''), slice(baseline, start, end), start);
  assert.match(current, /surveyBody\.innerHTML=html;\s+surveyElementCache\.clear\(\);/);
  assert.match(current, /checkSurveySubmission\(result\.submissionId\)/);
  assert.match(current, /result\.status==='completed'\)\{setSurveyCompleted\(\);return;/);
});

test('preview refresh never reads or changes a real participant session', async () => {
  const context = { window: { AI_US_PREVIEW: true }, sessionStorage: { getItem() { throw new Error('preview read real session'); } }, fetch() { throw new Error('preview sent network request'); } };
  const refresh = slice(current, '  function aiUsMaybeRefreshParticipantSession()', '  setInterval(');
  assert.equal(await vm.runInNewContext(refresh + '\naiUsMaybeRefreshParticipantSession();', context), false);
});

test('locally handled status, session and progress errors do not duplicate a global error dialog', async () => {
  const quiet = ['/api/v1/participant/survey-sessions/heartbeat', '/api/v1/survey-progress', '/api/v1/participant/survey-status', '/api/v1/participant/survey-configurations/2', '/api/v1/auth/participant/refresh'];
  for (const endpoint of [...quiet, '/api/v1/survey-responses', '/api/v1/auth/participant/login', '/api/v1/chat-submissions/uploads']) {
    for (const status of [0, 401, 403, 503]) {
      const { context, state } = requestContext();
      context.fetch = () => status
        ? Promise.resolve({ ok: false, status, json: async () => ({ detail: 'failure' }) })
        : Promise.reject(new TypeError('network'));
      await assert.rejects(context.aiUsRequest(endpoint));
      assert.equal(state.alerts, quiet.includes(endpoint) || status === 401 || status === 403 ? 0 : 1);
    }
  }
});

test('heartbeat preserves request payload, authorization and refresh after recovery', async () => {
  const { context, state, values } = requestContext();
  values.set('ai_us_access_token', 'fresh-test-token');
  values.set('ai_us_role', 'participant');
  const payload = { sessionId: 'test-session', activeSeconds: 90, visitedPageCount: 3, navigationCount: 4 };
  await context.aiUsRequest('/api/v1/participant/survey-sessions/heartbeat', { method: 'POST', headers: { Authorization: 'Bearer fresh-test-token' }, body: payload });
  assert.deepEqual(JSON.parse(state.calls[0].options.body), payload);
  assert.equal(state.calls[0].options.headers.Authorization, 'Bearer fresh-test-token');
  assert.equal(state.refreshes, 1);
  assert.equal(state.alerts, 0);
});

test('pre-request refresh distinguishes actual expiry from a connection failure', async () => {
  for (const outcome of ['refreshed', 'expired', 'offline']) {
    const refreshed = outcome === 'refreshed';
    const { context, state, values } = requestContext();
    values.set('ai_us_access_token', 'expired-test-token');
    values.set('ai_us_role', 'participant');
    if (outcome === 'expired') values.set('ai_us_session_expired', 'true');
    context.aiUsParticipantTokenExpiresSoon = token => token === 'expired-test-token';
    context.aiUsMaybeRefreshParticipantSession = () => { state.refreshes++; if (refreshed) values.set('ai_us_access_token', 'new-test-token'); return Promise.resolve(refreshed); };
    const pending = context.aiUsRequest('/api/v1/participant/survey-sessions/heartbeat', { headers: { Authorization: 'Bearer expired-test-token' } });
    if (refreshed) { await pending; assert.equal(state.calls[0].options.headers.Authorization, 'Bearer new-test-token'); }
    else { await assert.rejects(pending, error => error.status === (outcome === 'expired' ? 401 : 503)); assert.equal(state.calls.length, 0); }
  }
});

test('failed heartbeats retain cumulative activity and the next success sends it', async () => {
  const started = Date.parse('2026-10-19T00:00:00Z');
  let now = started;
  let connected = false;
  const requests = [];
  const events = [];
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: Clock, document: { visibilityState: 'visible' },
    sessionStorage: { getItem: () => 'test-token' }, SURVEY_ROUND: 1,
    SPEC: () => ({ surveyVersion: 'test-version' }),
    surveySession: { sessionId: 'same-session', startedAt: new Date(started).toISOString(), lastHeartbeatAt: new Date(started).toISOString(), activeSeconds: 0, resumeCount: 1, currentPage: 2, pageCount: 2, visitedPages: { 1: true, 2: true }, totalPageCount: 10, navigationCount: 2 },
    aiUsTrack: (...args) => events.push(args),
    aiUsRequest(endpoint, options) {
      requests.push({ endpoint, body: options.body });
      return connected ? Promise.resolve({}) : Promise.reject(new TypeError('offline'));
    },
  });
  vm.runInContext(slice(current, '    function sendSurveyHeartbeat()', '    window.aiUsStartParticipantSession='), context);
  for (const elapsed of [30000, 60000, 90000]) {
    now = started + elapsed;
    connected = elapsed === 90000;
    context.sendSurveyHeartbeat();
    await Promise.resolve();
  }
  assert.deepEqual(requests.map(request => request.body.activeSeconds), [30, 60, 90]);
  assert.ok(requests.every(request => request.body.sessionId === 'same-session' && request.body.visitedPageCount === 2 && request.body.navigationCount === 2));
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event[0] === 'survey_heartbeat' && event[1] === true));
  assert.equal(context.surveyDetail().activeSeconds, 90);
  assert.equal(context.surveyDetail().visitedPageCount, 2);
  assert.match(current, /surveyHeartbeatTimer=setInterval\(sendSurveyHeartbeat,30000\)/);
  assert.match(current, /setInterval\(saveSurveyDraft,30000\)/);
});

const definitions = vm.runInNewContext(slice(current, '    var SURVEY_SETS=', '    var SURVEY_PARTS=') + ';SURVEY_SETS;');
for (const specs of Object.values(definitions)) for (const spec of specs) {
  test(spec.surveyVersion + ': baseline answers, validation, immediate draft and fresh values match', () => {
    const beforeDom = fixture(spec), afterDom = fixture(spec);
    const before = surveyContext(baseline, spec, beforeDom), after = surveyContext(current, spec, afterDom);
    const compare = () => {
      assert.equal(JSON.stringify(after.context.collectAnswers()), JSON.stringify(before.context.collectAnswers()));
      assert.equal(after.context.surveyRemaining(), before.context.surveyRemaining());
      for (let index = 0; index < spec.scales.length; index++) assert.equal(after.context.scaleActive(index), before.context.scaleActive(index));
      before.context.saveSurveyDraft(); after.context.saveSurveyDraft();
      assert.equal(after.storage.get('draft'), before.storage.get('draft'));
      before.context.updateProgressMeta(); after.context.updateProgressMeta();
      for (const key of Object.keys(before.labels)) assert.deepEqual(after.labels[key], before.labels[key]);
      assert.equal(after.labels.progEta.style.display, 'none');
      assert.equal(after.labels.progMilestone.style.display, 'none');
    };
    compare();
    const warmQueries = afterDom.queryCount();
    compare();
    assert.equal(afterDom.queryCount(), warmQueries, 'warm input/progress paths should not rescan DOM');
    for (let index = 0; index < beforeDom.controls.length; index++) {
      for (const node of [beforeDom.controls[index], afterDom.controls[index]]) {
        node.checked = !node.checked;
        if (node.value) node.value = node.value === '__other__' ? 'KNOWN' : '2';
        if (node['data-slot']) node.value = 'TEST-' + node['data-slot'];
        if (node.style.display !== undefined) node.style.display = 'none';
      }
    }
    compare();
    for (const node of [...beforeDom.controls, ...afterDom.controls]) { node.checked = false; node.value = ''; }
    compare();
    after.context.surveyElementCache.clear();
    compare();
    assert.ok(afterDom.queryCount() > warmQueries, 'rerender invalidation must refresh DOM references');
  });
}

const t2Definitions = vm.runInNewContext('(' + current.match(/var SURVEY_SETS_T2=([\s\S]*?);\n\s*var SURVEY_ROUND=/)[1] + ')').common;

test('restored participant sessions validate with the server and preserve profile and drafts', async () => {
  for (const needsPasswordChange of [false, true]) {
    const storage = new Map([['ai_us_access_token', 'saved-token'], ['ai_us_role', 'participant'], ['ai_us_profile_grade', '5']]);
    let opened = 0, passwordPrompt = 0, calls = 0;
    const context = vm.createContext({
      window: {}, participantRestoreInFlight: null, participantSessionNeedsValidation: false,
      sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      aiUsRequest: async (requestPath, options) => {
        calls++;assert.equal(requestPath, '/api/v1/auth/participant/refresh');assert.equal(options.headers.Authorization, 'Bearer saved-token');
        return { accessToken: 'validated-token', role: 'participant', audience: 'elementary', chatConsent: true, needsPasswordChange };
      },
      getAudience: () => 'elementary', applyChatConsent() {}, closeLogin() {}, updateSurveyRetryButton() {},
      openSurveys() { opened++; }, openFirstPasswordChange() { passwordPrompt++; },
    });
    vm.runInContext(slice(current, '    function restoreParticipantSession()', '    function openSurveys('), context);
    await Promise.all([context.restoreParticipantSession(), context.restoreParticipantSession()]);
    assert.equal(calls, 1);
    assert.equal(storage.get('ai_us_access_token'), 'validated-token');
    assert.equal(storage.get('ai_us_profile_grade'), '5');
    assert.equal(opened, needsPasswordChange ? 0 : 1);
    assert.equal(passwordPrompt, needsPasswordChange ? 1 : 0);
    context.window.AI_US_PREVIEW = true;
    assert.equal(await context.restoreParticipantSession(), false);
    assert.equal(calls, 1);
  }
});

test('session restore retains offline sessions but sends actual authentication failures to login', async () => {
  for (const status of [0, 401, 403]) {
    const values = new Map([['ai_us_access_token', 'saved-token'], ['ai_us_role', 'participant'], ['ai_us_profile_grade', '5']]);
    let listShown = 0, loginShown = 0, notices = 0;
    const context = vm.createContext({
      window: {}, participantRestoreInFlight: null, participantSessionNeedsValidation: false,
      participantExpiryNoticeOpen: false, participantResumeTarget: null,
      dummySurveyBackdrop: { classList: { contains: () => false, remove() {} } },
      dummySubmissionCompleted: false, isT2Survey: () => true,
      sessionStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
      aiUsRequest: () => Promise.reject(Object.assign(new Error('unavailable'), { status })),
      surveys: { classList: { add() { listShown++; } } }, document: { body: { style: {} } },
      updatePartButtons() {}, updateSurveyRetryButton() {}, closeSurveys() {},
      openLogin() { loginShown++; }, closeLogin() {}, showErr() {},
      aiUsAudienceDialog(options) { notices++; assert.equal(options.confirmText, '다시 로그인하기'); return Promise.resolve(true); },
    });
    vm.runInContext(slice(current, '    function requestParticipantLogin()', '    function updateSurveyRetryButton('), context);
    vm.runInContext(slice(current, '    function restoreParticipantSession()', '    function openSurveys('), context);
    assert.equal(await context.restoreParticipantSession(), false);
    assert.equal(values.has('ai_us_access_token'), status === 0);
    assert.equal(context.participantSessionNeedsValidation, status === 0);
    assert.equal(listShown, status === 0 ? 1 : 0);
    assert.equal(loginShown, status === 0 ? 0 : 1);
    assert.equal(notices, status === 0 ? 0 : 1);
    assert.equal(values.get('ai_us_profile_grade'), '5');
  }
});

test('failed status lookup retries once, keeps its busy control, and survives token rotation', async () => {
  const values = new Map([['ai_us_access_token', 'token-1'], ['ai_us_participant_phone', 'synthetic-participant']]);
  const button = { hidden: true, setAttribute(name, value) { this[name] = value; } };
  let complete, requests = 0;
  const context = vm.createContext({
    participantResumeTarget: null,
    window: {}, serverStatusInFlight: null, participantRestoreInFlight: null, participantSessionNeedsValidation: false,
    serverCompletedVersions: {}, serverVersionsByRound: {}, serverCompletedRounds: [], serverStatusReady: false,
    serverStatusFailed: false, surveyRoundStates: {}, surveyRoundsOpen: {}, t1SubmissionsOpen: false,
    sessionStorage: { getItem: key => values.get(key) || null },
    document: { getElementById: () => button },
    loadSurveyConfigurations: () => Promise.resolve(),
    aiUsRequest: () => { requests++; return new Promise(resolve => { complete = resolve; }); },
    updatePartButtons() { context.updateSurveyRetryButton(); },
    resumeParticipantSurvey() {},
  });
  vm.runInContext(slice(current, '    function loadServerSurveyProgress()', '    function restoreParticipantSession('), context);
  context.aiUsRequest = () => { requests++; return Promise.reject(new Error('offline')); };
  await context.loadServerSurveyProgress();
  assert.equal(context.serverStatusFailed, true);
  assert.equal(button.hidden, false);
  context.aiUsRequest = () => { requests++; return new Promise(resolve => { complete = resolve; }); };
  const pending = context.retrySurveyStatus();
  context.retrySurveyStatus();
  assert.equal(requests, 2, 'double click must not send another request');
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(button['aria-busy'], 'true');
  values.set('ai_us_access_token', 'token-2');
  complete({ t1SubmissionsOpen: false, completedVersionsByRound: { '2': ['part1'] } });
  await pending;
  assert.equal(context.serverStatusReady, true, 'same participant token rotation is not logout');
  assert.equal(context.serverCompletedVersions.part1, true);
  assert.equal(button.hidden, true);
  assert.equal(button.disabled, false);
});

test('AI ranks reject duplicate names but allow repeated none and distinct other names', () => {
  const spec = t2Definitions[0], dom = fixture(spec);
  const { context } = surveyContext(current, spec, dom);
  const question = spec.scales.flatMap(scale => scale.questions).find(item => item.key === 'usage.q13');
  const answered = values => context.isAnswered(question, { [question.key]: values });
  assert.equal(answered([question.source[0], question.source[0], question.source[1]]), false);
  assert.equal(answered([question.source[0], ' chatgpt ', question.source[1]]), false);
  assert.equal(answered(['Custom AI', ' custom ai ', question.source[1]]), false);
  assert.equal(answered([question.source[0], question.noneOption, question.noneOption]), true);
  assert.equal(answered(['Custom AI 1', 'Custom AI 2', question.source[0]]), true);
  assert.equal(answered([question.source[0], question.source[1]]), false);
  for (const source of question.source) {
    const english = source.split(' (')[0], korean = source.match(/\(([^()]+)\)/)[1];
    for (const alias of [english.toUpperCase(), english.toLowerCase(), source.toUpperCase(), ' ' + korean + ' ']) {
      assert.equal(answered([source, alias, question.noneOption]), false, source + ' matches ' + alias);
    }
    assert.equal(answered([english, korean, question.noneOption]), false, 'English and Korean aliases resolve to the same AI');
  }
  assert.equal(answered([question.source[0], ' cHaTgPt ', question.noneOption]), false);
  assert.equal(answered([question.source[1], ' gEmInI ', question.noneOption]), false);
  assert.equal(answered(['챗지피티', '제미나이', '클로드']), true, 'different Korean aliases remain distinct');
});

test('rank choices unlock on change, keep none repeatable and flag duplicate restored or other answers', () => {
  const spec = t2Definitions[0], dom = fixture(spec);
  const { context } = surveyContext(current, spec, dom);
  const question = spec.scales.flatMap(scale => scale.questions).find(item => item.key === 'usage.q13');
  const controls = dom.selectors.get('[data-rank="' + question.key + '"]');
  const errors = controls.map((control, index) => {
    control.options = ['', ...question.source, question.noneOption, '__other__'].map(value => ({ value, disabled: false, textContent: value }));
    control.value = index ? question.noneOption : question.source[0];
    const error = { textContent: '', hidden: true };
    dom.selectors.set('[data-rank-error="' + question.key + '"][data-slot="' + (index + 1) + '"]', [error]);
    return error;
  });
  dom.controls.forEach(control => { control.setAttribute = function(name, value) { this[name] = value; }; });
  vm.runInContext(slice(current, '    function updateRankQuestion(', '    function bindConditionals('), context);
  const option = (slot, value) => controls[slot].options.find(item => item.value === value);
  context.updateRankQuestion(question);
  assert.equal(option(1, question.source[0]).disabled, true);
  assert.match(option(1, question.source[0]).textContent, /1순위에서 선택됨/);
  assert.equal(option(2, question.noneOption).disabled, false);
  assert.equal(option(1, '__other__').disabled, false);
  assert.ok(errors.every(error => error.hidden));
  controls[0].value = question.source[1];
  context.updateRankQuestion(question);
  assert.equal(option(1, question.source[0]).disabled, false);
  assert.equal(option(1, question.source[0]).textContent, question.source[0]);
  controls[1].value = question.source[1];
  context.updateRankQuestion(question);
  assert.equal(controls[1].value, question.source[1], 'do not silently erase a duplicate draft');
  assert.equal(controls[0]['aria-invalid'], 'true');
  assert.equal(errors[0].hidden, false);
  for (const index of [0, 1]) {
    controls[index].value = '__other__';
    dom.selectors.get('[data-rank-other="' + question.key + '"][data-slot="' + (index + 1) + '"]')[0].value = index ? ' custom ai ' : 'Custom AI';
  }
  context.updateRankQuestion(question);
  assert.equal(errors[1].hidden, false);
  dom.selectors.get('[data-rank-other="' + question.key + '"][data-slot="2"]')[0].value = 'Different AI';
  context.updateRankQuestion(question);
  assert.ok(errors.every(error => error.hidden));
  assert.equal(controls[0]['aria-invalid'], 'false');
  controls[0].value = question.source[1];
  const other = dom.selectors.get('[data-rank-other="' + question.key + '"][data-slot="2"]')[0];
  other.value = ' 제미나이 ';
  context.updateRankQuestion(question);
  assert.equal(errors[0].hidden, false);
  assert.equal(errors[1].hidden, false);
  assert.equal(controls[1]['aria-invalid'], 'true');
  assert.equal(other.value, ' 제미나이 ', 'preserve duplicate text for correction');
  controls[0].value = question.noneOption;
  context.updateRankQuestion(question);
  assert.ok(errors.every(error => error.hidden));
  assert.equal(option(2, question.source[1]).disabled, true, 'Korean other text locks the matching dropdown choice');
});

test('max-selection feedback stays next to the rejected choice and clears after deselection', () => {
  const spec = t2Definitions[0], dom = fixture(spec);
  const { context } = surveyContext(current, spec, dom);
  const key = 'usetype.C1', inputs = dom.selectors.get('input[data-multi="' + key + '"]');
  const notes = inputs.map(() => ({ textContent: '', hidden: true }));
  const counter = { textContent: '' }, removed = [];
  const card = {
    querySelectorAll: () => notes,
    querySelector: selector => notes[inputs.findIndex(input => selector === '[data-multi-feedback-for="' + input.value + '"]')],
  };
  dom.selectors.set('[data-multi-count="' + key + '"]', [counter]);
  inputs.forEach((input, index) => {
    input.checked = index < 4;
    input['data-multi'] = key;
    input['data-multi-max'] = '3';
    input.matches = () => true;
    input.closest = selector => selector === '.q-card' ? card : { classList: { remove: value => removed.push(value) } };
  });
  context.showSurveyErr = () => { throw new Error('max-selection feedback must not use the page footer'); };
  vm.runInContext(slice(current, '    function updateMultiCount(', '    function renderSurvey('), context);
  context.enforceMultiMax({ target: inputs[3] });
  assert.equal(inputs[3].checked, false);
  assert.equal(inputs.filter(input => input.checked).length, 3);
  assert.match(notes[3].textContent, /먼저 하나를 해제/);
  assert.equal(notes[3].hidden, false);
  assert.match(counter.textContent, /현재 3개 선택/);
  context.enforceMultiMax({ target: inputs[3] });
  assert.equal(notes[3].hidden, false, 'subsequent change must preserve the rejected input feedback');
  inputs[0].checked = false;
  context.enforceMultiMax({ target: inputs[0] });
  assert.ok(notes.every(note => note.hidden && !note.textContent));
  assert.match(counter.textContent, /현재 2개 선택/);
  inputs[3].checked = true;
  context.enforceMultiMax({ target: inputs[3] });
  assert.equal(inputs[3].checked, true);
  assert.match(counter.textContent, /현재 3개 선택/);
  assert.deepEqual(removed, ['selected']);
});

test('T2 required reasons, integer amounts and max selections are enforced', () => {
  const spec = t2Definitions[0], dom = fixture(spec);
  const { context } = surveyContext(current, spec, dom);
  assert.equal(context.isAnswered({ type: 'single', key: 'followup.q1', other: { when: 3, field: { key: 'reason' } } }, { 'followup.q1': 3, reason: '  ' }), false);
  const paid = spec.scales.flatMap(scale => scale.questions).find(question => question.key === 'usage.q17');
  assert.equal(context.isAnswered(paid, { 'usage.q17': 2, 'usage.q17_amount': 0.5 }), false);
  assert.equal(context.isAnswered(paid, { 'usage.q17': 2, 'usage.q17_amount': 0 }), true);
  const max = spec.scales.flatMap(scale => scale.questions).find(question => question.key === 'usetype.C1');
  assert.equal(context.isAnswered(max, { 'usetype.C1': [1, 2, 3, 4] }), false);
  assert.equal(context.isAnswered(max, { 'usetype.C1': [1, 2, 3] }), true);
});

test('T2 gift preference is required, single-choice and immediately precedes the unchanged followup', () => {
  const spec = t2Definitions[1], dom = fixture(spec);
  const { context } = surveyContext(current, spec, dom);
  const rewardIndex = spec.scales.findIndex(scale => scale.scaleId === 'reward');
  assert.equal(spec.scales[rewardIndex + 1].scaleId, 'followup');
  const question = spec.scales[rewardIndex].questions[0];
  assert.equal(question.key, 'reward.gifticon');
  assert.equal(question.required, true);
  assert.equal(question.type, 'single');
  assert.equal(JSON.stringify(question.options.map(option => option.value)), '[1,2,3,4,5]');
  assert.match(question.helper.join(' '), /다음 평일/);
  const radios = dom.selectors.get('input[name="reward.gifticon"]');
  radios.forEach(control => { control.checked = false; });
  assert.equal(context.isAnswered(question, context.collectAnswers()), false);
  for (const option of question.options) {
    radios.forEach(control => { control.checked = Number(control.value) === option.value; });
    const answers = context.collectAnswers();
    assert.equal(answers['reward.gifticon'], option.value);
    assert.equal(context.isAnswered(question, answers), true);
  }
  const followup = spec.scales[rewardIndex + 1].questions[0];
  assert.equal(followup.key, 'followup.q1');
  assert.equal(followup.other.when, 3);
  assert.equal(followup.other.field.key, 'followup.q1_reason');
});

test('T2 restores branch dependencies and multi other text from raw questions', () => {
  for (const [spec, answers] of [
    [t2Definitions[1], { 'demo.enrolled': 2, 'demo.outStudy': 1, 'acmot.g1': 'GOAL', 'acmot.q1': 3 }],
    [t2Definitions[0], { 'usetype.A12': [5], 'usetype.A12_other': 'CUSTOM' }],
    [t2Definitions[1], { 'followup.q1': 3, 'followup.q1_reason': '일정이 맞지 않아요.' }],
  ]) {
    const dom = fixture(spec);
    for (const node of dom.controls) { node.checked = false; if (node.value === 'TEST' || node.value === 'OTHER') node.value = ''; }
    const { context, storage } = surveyContext(current, spec, dom);
    storage.set('draft', JSON.stringify(answers));
    context.bindConditionals = () => {};
    context.initUniqueSelects = () => {};
    context.dummySurveyStatus = {};
    vm.runInContext(slice(current, '    function restoreDraft()', '    function saveSurveyDraft('), context);
    context.restoreDraft();
    const restored = context.collectAnswers();
    for (const key of Object.keys(answers)) assert.equal(JSON.stringify(restored[key]), JSON.stringify(answers[key]), key);
    if (spec.part === 2) assert.equal(restored['reward.gifticon'] == null, true, 'legacy drafts must not silently choose a gift');
  }
});

test('a different device restores the server checkpoint without a local draft', async () => {
  const record = { revision: 7, nextPage: 3, completed: false, answers: { 'followup.q1': 2, 'reward.gifticon': 4 } };
  const context = vm.createContext({
    progressContext: { round: 2, version: 't2-part2-v9-1022', key: 'same-account-draft', ready: false },
    window: {}, progressIsCurrent: () => true,
    sessionStorage: { getItem: () => 'same-account-new-device-token' },
    localStorage: { getItem: () => null },
    aiUsRequest: async () => record,
    restoreServerSnapshot(context, snapshot) { context.restored = snapshot; },
    flushProgress() {}, dummySurveyStatus: {},
  });
  vm.runInContext(slice(current, '    function loadSavedProgress()', '    function queueProgress('), context);
  context.loadSavedProgress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.progressContext.restored, record);
  assert.equal(context.progressContext.revision, 7);
  assert.equal(context.progressContext.ready, true);
});

test('expiry saves before clearing authentication and shows only one locked notice', async () => {
  const values = new Map([['ai_us_access_token', 'expired'], ['ai_us_role', 'participant'], ['ai_us_participant_phone', 'account-a']]);
  let saved = 0, notices = 0, loggedIn = 0, confirmNotice;
  const context = vm.createContext({
    window: {}, participantExpiryNoticeOpen: false, participantResumeTarget: null,
    sessionStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    dummySurveyBackdrop: { classList: { contains: () => true, remove() {} } },
    dummySubmissionCompleted: false, SURVEY_ROUND: 2, activePart: 1, currentPage: 3,
    SPEC: () => ({ surveyVersion: 'part-two' }), isT2Survey: () => true,
    progressContext: {}, surveyDraftOwner: 'account-a', closeSurveys() {}, closeLogin() {}, showErr() {},
    saveSurveyDraft(answers, page) { saved++; assert.equal(values.get('ai_us_access_token'), 'expired'); assert.equal(page, 3); },
    aiUsAudienceDialog(options) { notices++; assert.equal(options.lockFocus, true); assert.ok(options.message.includes('최근 입력')); return new Promise(resolve => { confirmNotice = resolve; }); },
    openLogin() { loggedIn++; },
  });
  vm.runInContext(slice(current, '    function requestParticipantLogin()', '    function updateSurveyRetryButton('), context);
  context.requestParticipantLogin(); context.requestParticipantLogin();
  assert.equal(saved, 1); assert.equal(notices, 1); assert.equal(loggedIn, 0);
  assert.equal(values.has('ai_us_access_token'), false);
  assert.equal(context.progressContext, null); assert.equal(context.surveyDraftOwner, null);
  assert.equal(context.participantResumeTarget.phone, 'account-a');
  assert.equal(context.participantResumeTarget.page, 3);
  confirmNotice(true); await new Promise(setImmediate);
  assert.equal(loggedIn, 1);
});

test('resume requires the same account, version, open round and completed prerequisite', () => {
  const target = { phone: 'account-a', round: 2, part: 1, version: 'part-two', page: 3 };
  let opened = 0;
  const context = vm.createContext({
    serverStatusReady: true, participantResumeTarget: null,
    sessionStorage: { getItem: () => 'account-a' }, partsForRound: () => [{}, { surveyVersion: 'part-two' }],
    surveyRoundOpen: () => true, roundPartCompleted: (round, part) => part === 0,
    openSurvey() { opened++; }, isT2Survey: () => true,
  });
  vm.runInContext(slice(current, '    function resumeParticipantSurvey()', '    function updateSurveyRetryButton('), context);
  for (const change of [{ phone: 'account-b' }, { version: 'old-version' }]) {
    context.participantResumeTarget = { ...target, ...change }; context.resumeParticipantSurvey(); assert.equal(opened, 0);
  }
  context.participantResumeTarget = { ...target }; context.surveyRoundOpen = () => false;
  context.resumeParticipantSurvey(); assert.equal(opened, 0);
  context.participantResumeTarget = { ...target }; context.surveyRoundOpen = () => true; context.roundPartCompleted = () => false;
  context.resumeParticipantSurvey(); assert.equal(opened, 0);
  context.participantResumeTarget = { ...target }; context.roundPartCompleted = (round, part) => part === 0;
  context.resumeParticipantSurvey(); assert.equal(opened, 1); assert.equal(context.participantResumeTarget, null);
});

test('draft autosave cannot write expired or differently owned survey contents', () => {
  for (const expired of [true, false]) {
    const { context, storage } = surveyContext(current, t2Definitions[0], fixture(t2Definitions[0]));
    if (expired) context.sessionStorage = { getItem: key => key === 'ai_us_access_token' ? null : 'account-b' };
    else context.surveyDraftOwner = 'account-a-draft';
    context.saveSurveyDraft(); assert.equal(storage.size, 0);
  }
});

test('only current participant authenticated 401 responses trigger session expiry', async () => {
  for (const [status, endpoint, role, token] of [[401, '/api/v1/survey-responses', 'participant', 'current'], [403, '/api/v1/survey-responses', 'participant', 'current'], [503, '/api/v1/survey-progress', 'participant', 'current'], [401, '/api/v1/auth/participant/login', 'participant', 'current'], [401, '/api/v1/survey-responses', 'researcher', 'current'], [401, '/api/v1/survey-responses', 'participant', 'old']]) {
    const { context, state, values } = requestContext();
    let notices = 0;
    context.window = { aiUsParticipantSessionExpired() { notices++; } };
    values.set('ai_us_access_token', 'current'); values.set('ai_us_role', role);
    context.fetch = async () => ({ ok: false, status, json: async () => ({}) });
    await assert.rejects(context.aiUsRequest(endpoint, { headers: { Authorization: 'Bearer ' + token } }));
    assert.equal(notices, status === 401 && !endpoint.includes('/auth/') && role === 'participant' && token === 'current' ? 1 : 0);
  }
});

test('refresh keeps its rolling contract and ignores stale account responses', async () => {
  for (const [status, stale] of [[200, false], [401, false], [403, false], [503, false], [0, false], [200, true], [401, true]]) {
    const values = new Map([['ai_us_access_token', 'original'], ['ai_us_role', 'participant']]);
    let notices = 0, calls = 0;
    const context = vm.createContext({
      window: { aiUsParticipantSessionExpired() { notices++; } },
      AI_US_PARTICIPANT_REFRESH_IN_FLIGHT: null, AI_US_API_BASE: 'https://invalid.test',
      aiUsParticipantTokenExpiresSoon: () => true,
      sessionStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
      fetch: async (url, options) => {
        calls++; assert.equal(options.headers.Authorization, 'Bearer original');
        if (stale) values.set('ai_us_access_token', 'new-account-token');
        if (!status) throw new TypeError('offline');
        return { ok: status === 200, status, json: async () => ({ accessToken: 'rotated', chatConsent: true }) };
      },
    });
    vm.runInContext(slice(current, '  function aiUsMaybeRefreshParticipantSession()', '  setInterval(function(){aiUsMaybeRefreshParticipantSession();}'), context);
    const pending = context.aiUsMaybeRefreshParticipantSession();
    assert.equal(context.aiUsMaybeRefreshParticipantSession(), pending);
    assert.equal(await pending, status === 200 && !stale);
    assert.equal(calls, 1);
    assert.equal(notices, status === 401 && !stale ? 1 : 0);
    assert.equal(values.get('ai_us_access_token'), stale ? 'new-account-token' : status === 200 ? 'rotated' : 'original');
    assert.equal(context.AI_US_PARTICIPANT_REFRESH_IN_FLIGHT, null);
  }
});

test('CTA precedes artwork and participant contact copy consistently uses CALM', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.indexOf('id="startBtn"') < html.indexOf('<div class="stage">'));
  assert.equal((html.match(/id="startBtn"/g) || []).length, 1);
  assert.ok(html.includes('id="toSignup" class="linkbtn">설문 참여 신청'));
  assert.ok(html.includes('설문 참여 신청이나 로그인에 어려움이 있으면 편하게 문의주세요.'));
  assert.ok(html.includes('href="tel:010-9386-0839">010.9386.0839'));
  assert.equal(html.includes('calm'), false);
  assert.equal(html.includes('로그인 정보는 디지털상담'), false);
});

test('preview footer shares survey title labels and follows part changes', () => {
  const elements = { dummySurveyTitle: {}, surveyPreviewFooter: {} };
  const context = vm.createContext({
    SURVEY_ROUND: 2, activePart: 0, window: { AI_US_PREVIEW: true },
    document: { getElementById: key => elements[key] || null },
    getAudience: () => 'elementary',
  });
  vm.runInContext(slice(current, '    function updateSurveyTitle()', '    function openSurvey('), context);
  for (const [round, audience, part, label] of [
    [2, 'elementary', 0, '공통 파트 1'],
    [2, 'elementary', 1, '공통 파트 2'],
    [2, 'secondary', 1, '공통 파트 2'],
    [1, 'secondary', 1, '중고등 파트 2'],
    [1, 'elementary', 0, '초등 파트 1'],
  ]) {
    context.SURVEY_ROUND = round;
    context.activePart = part;
    context.getAudience = () => audience;
    context.updateSurveyTitle();
    assert.equal(elements.dummySurveyTitle.textContent, round + '회차 설문 · ' + label);
    assert.ok(elements.surveyPreviewFooter.textContent.endsWith('(' + label + ')'));
  }
  delete elements.surveyPreviewFooter;
  context.updateSurveyTitle();
  assert.match(slice(current, '    function openSurvey(', '    function checkSurveySubmission('), /updateSurveyTitle\(\);/);
  assert.match(current, /document\.body\.appendChild\(bar\);\s+updateSurveyTitle\(\);/);
});

test('round admission locks both parts, preserves completed labels and enforces prerequisites', () => {
  const buttons = new Map(), completed = new Set(['1:0']);
  for (const round of [1, 2, 3, 4]) for (const part of [0, 1]) {
    buttons.set(round + ':' + part, { classList: { toggle() {} }, parentNode: { querySelector: () => ({}) } });
  }
  const context = vm.createContext({
    window: {}, SURVEY_ROUND: 2, SURVEY_PARTS: [], serverStatusReady: true,
    surveyRoundsOpen: { '1': false, '2': false }, partsForRound: () => [], updateRoundProgress() {},
    surveyRoundStates: { '1': 'closed', '2': 'closed' }, serverStatusFailed: false, updateSurveyRetryButton() {},
    roundPartCompleted: (round, part) => completed.has(round + ':' + part),
    document: { getElementById: () => null, querySelector(selector) { const match = selector.match(/data-round="(\d)"\]\[data-part="(\d)"/); return match ? buttons.get(match[1] + ':' + match[2]) : null; } },
  });
  vm.runInContext(slice(current, '    function surveyRoundOpen(', '    function updateRoundProgress('), context);
  context.updatePartButtons();
  assert.ok([...buttons.values()].every(button => button.disabled));
  assert.equal(buttons.get('1:0').textContent, '제출 완료');
  assert.equal(buttons.get('2:0').textContent, '참여 기간이 끝났어요');
  assert.equal(buttons.get('3:0').textContent, '설문 준비 중');
  assert.equal(buttons.get('4:1').textContent, '설문 준비 중');
  context.surveyRoundsOpen['2'] = true; context.surveyRoundStates['2'] = 'open'; context.updatePartButtons();
  assert.equal(buttons.get('2:0').disabled, false);
  assert.equal(buttons.get('2:1').disabled, true);
  completed.add('2:0'); context.updatePartButtons();
  assert.equal(buttons.get('2:1').disabled, false);
  context.surveyRoundsOpen['2'] = 'true'; context.updatePartButtons();
  assert.equal(buttons.get('2:1').disabled, true);
  context.serverStatusReady = false; context.updatePartButtons();
  assert.equal(buttons.get('2:0').textContent, '확인 중');
  context.serverStatusFailed = true; context.updatePartButtons();
  assert.equal(buttons.get('2:0').textContent, '확인 실패');
  context.window.AI_US_PREVIEW = true; context.updatePartButtons();
  assert.equal(buttons.get('2:1').disabled, false);
});

test('participant status uses DB round map, supports old backend and fails closed on lookup error', async () => {
  const context = vm.createContext({
    participantResumeTarget: null,
    window: {}, sessionStorage: { getItem: () => 'synthetic-token' },
    document: { getElementById: () => null },
    serverCompletedVersions: {}, serverVersionsByRound: {}, serverCompletedRounds: [],
    serverStatusReady: false, surveyRoundsOpen: {}, t1SubmissionsOpen: false,
    serverStatusFailed: false, surveyRoundStates: {}, loadSurveyConfigurations: () => Promise.resolve(), serverStatusInFlight: null,
    updatePartButtons() {}, updateSurveyRetryButton() {},
    aiUsRequest: () => Promise.resolve({ completedVersionsByRound: { '2': ['part1'] }, completedRounds: [], t1SubmissionsOpen: false, surveyRoundsOpen: { '1': false, '2': false, '3': true, '4': false } }),
  });
  vm.runInContext(slice(current, '    function loadServerSurveyProgress()', '    function openSurveys('), context);
  context.loadServerSurveyProgress(); await new Promise(setImmediate);
  assert.equal(context.serverStatusReady, true);
  assert.equal(context.surveyRoundsOpen['2'], false);
  assert.equal(context.surveyRoundsOpen['3'], true);
  assert.equal(context.serverCompletedVersions.part1, true);
  context.aiUsRequest = () => Promise.resolve({ t1SubmissionsOpen: false });
  context.loadServerSurveyProgress(); await new Promise(setImmediate);
  assert.equal(context.surveyRoundsOpen['1'], false);
  assert.equal(context.surveyRoundsOpen['2'], true);
  context.aiUsRequest = () => Promise.reject(new Error('unavailable'));
  context.loadServerSurveyProgress(); await new Promise(setImmediate);
  assert.equal(context.serverStatusReady, false);
  context.window.AI_US_PREVIEW = true;
  context.aiUsRequest = () => { throw new Error('preview must not request status'); };
  context.loadServerSurveyProgress();
});

test('selected DB configurations load in part order, cache by versions and do not affect preview', async () => {
  const versions = [1, 2].map(part => ({ surveyVersion: 'selected-part' + part, audience: 'all', part }));
  const calls = [];
  const definitions = versions.map(version => ({ ...version, surveyRound: 2, spec: { scales: [{ scaleId: 'selected', questions: [] }] } })).reverse();
  const context = vm.createContext({
    configuredSurveyParts: {}, configurationSignatures: {}, window: {}, getAudience: () => 'secondary',
    sessionStorage: { getItem: key => key === 'ai_us_access_token' ? 'synthetic-token' : null },
    SURVEY_SETS_T2: { common: [{ marker: 'embedded' }] }, SURVEY_SETS: { elementary: [] },
    aiUsRequest: (requestPath, options) => {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token', 'selected survey definitions require participant authentication');
      calls.push(requestPath);
      return Promise.resolve(definitions);
    },
  });
  vm.runInContext(slice(current, '    function loadSurveyConfigurations(', '    function loadServerSurveyProgress('), context);
  vm.runInContext(slice(current, '    function partsForRound(', '    function roundPartCompleted('), context);
  const data = { surveyConfigurations: { '2': versions, '3': [] } };
  await context.loadSurveyConfigurations(data);
  assert.deepEqual(Array.from(context.partsForRound(2), part => part.surveyVersion), ['selected-part1', 'selected-part2']);
  assert.equal(calls[0], '/api/v1/participant/survey-configurations/2');
  await context.loadSurveyConfigurations(data);
  assert.equal(calls.length, 1);
  context.window.AI_US_PREVIEW = true;
  assert.equal(context.partsForRound(2)[0].marker, 'embedded');
  context.window.AI_US_PREVIEW = false;
  await assert.rejects(context.loadSurveyConfigurations({ surveyConfigurations: { '2': [{ surveyVersion: 'missing', audience: 'all', part: 1 }] } }));
  await context.loadSurveyConfigurations({ surveyConfigurations: { '2': [] } });
  assert.equal(context.configuredSurveyParts['2'], undefined);
});

test('direct survey opening cannot bypass round closure, status readiness or part-one completion', () => {
  const context = vm.createContext({
    window: {}, SURVEY_ROUND: 2, SURVEY_PARTS: [], activePart: 0,
    surveyRoundsOpen: { '2': false }, serverStatusReady: true,
    partsForRound: () => [], partCompleted: () => false, draftKey: () => 'draft',
  });
  vm.runInContext(slice(current, '    function surveyRoundOpen(', '    function updatePartButtons('), context);
  vm.runInContext(slice(current, '    function openSurvey(partIndex){', '      progressContext=isT2Survey()') + 'return "opened";}', context);
  assert.equal(context.openSurvey(0), undefined);
  context.surveyRoundsOpen['2'] = true;
  assert.equal(context.openSurvey(0), 'opened');
  assert.equal(context.openSurvey(1), undefined);
  context.partCompleted = () => true;
  assert.equal(context.openSurvey(1), 'opened');
  context.serverStatusReady = false;
  assert.equal(context.openSurvey(0), undefined);
  context.window.AI_US_PREVIEW = true;
  context.surveyRoundsOpen['2'] = false;
  assert.equal(context.openSurvey(0), 'opened');
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