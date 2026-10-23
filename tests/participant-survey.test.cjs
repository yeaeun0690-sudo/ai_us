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
    window: {}, progressContext: null,
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

test('inline scripts parse and tracking, submission remain unchanged', () => {
  new vm.Script(current);
  for (const [start, end] of [
    ['    function sendSurveyHeartbeat()', '    window.aiUsStartParticipantSession='],
    ['  function aiUsMaybeRefreshParticipantSession()', '  function aiUsShowTemporaryIssue()'],
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

test('only heartbeat and partial progress suppress network and server error dialogs', async () => {
  for (const endpoint of ['/api/v1/participant/survey-sessions/heartbeat', '/api/v1/survey-progress', '/api/v1/survey-responses', '/api/v1/auth/participant/login', '/api/v1/chat-submissions/uploads']) {
    for (const status of [0, 401, 403, 503]) {
      const { context, state } = requestContext();
      context.fetch = () => status
        ? Promise.resolve({ ok: false, status, json: async () => ({ detail: 'failure' }) })
        : Promise.reject(new TypeError('network'));
      await assert.rejects(context.aiUsRequest(endpoint));
      assert.equal(state.alerts, endpoint.endsWith('/heartbeat') || endpoint.endsWith('/survey-progress') || status === 401 || status === 403 ? 0 : 1);
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

test('pre-request token refresh and expired-session rejection are preserved', async () => {
  for (const refreshed of [true, false]) {
    const { context, state, values } = requestContext();
    values.set('ai_us_access_token', 'expired-test-token');
    values.set('ai_us_role', 'participant');
    context.aiUsParticipantTokenExpiresSoon = token => token === 'expired-test-token';
    context.aiUsMaybeRefreshParticipantSession = () => { state.refreshes++; if (refreshed) values.set('ai_us_access_token', 'new-test-token'); return Promise.resolve(refreshed); };
    const pending = context.aiUsRequest('/api/v1/participant/survey-sessions/heartbeat', { headers: { Authorization: 'Bearer expired-test-token' } });
    if (refreshed) { await pending; assert.equal(state.calls[0].options.headers.Authorization, 'Bearer new-test-token'); }
    else { await assert.rejects(pending, error => error.status === 401); assert.equal(state.calls.length, 0); }
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

test('T2 restores branch dependencies and multi other text from raw questions', () => {
  for (const [spec, answers] of [
    [t2Definitions[1], { 'demo.enrolled': 2, 'demo.outStudy': 1, 'acmot.g1': 'GOAL', 'acmot.q1': 3 }],
    [t2Definitions[0], { 'usetype.A12': [5], 'usetype.A12_other': 'CUSTOM' }],
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
  }
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