import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { Window } from 'happy-dom';
import { appearanceFor } from '../src/appearance.ts';
import { STATUS_STYLE } from '../src/status-style.ts';

// Execute the real UI and state helpers. This verifies DOM behavior, not CSS layout,
// browser installation, fullscreen presentation, or WebGL rendering.
const sourceRoot = new URL('../src/', import.meta.url);
const timestamp = '2026-01-01T10:00:00.000Z';
const snapshot = (changes = {}) => ({
  id: 'snapshot-working', timestamp, source: 'codex', type: 'agent.status',
  agentId: 'worker-live', agentName: '연결된 직원', status: 'working',
  title: '로컬 도구 사용', taskId: 'turn-live', projectId: 'project-live',
  projectName: '실제 프로젝트', sessionId: 'session-live', sessionName: '실제 채팅',
  model: 'reported-model', modelEvidence: 'reported', observation: 'codex-log',
  ...changes,
});
const initialSnapshots = () => [
  snapshot(),
  snapshot({ id: 'snapshot-idle', source: 'claude', agentId: 'worker-idle', agentName: '대기 직원',
    status: 'idle', projectId: 'project-idle', projectName: '대기 프로젝트', sessionId: 'session-idle' }),
  snapshot({ id: 'snapshot-retired', agentId: 'worker-retired', agentName: '퇴근 직원',
    type: 'agent.retired', retired: true, projectId: 'project-retired', projectName: '지난 프로젝트' }),
  snapshot({ id: 'snapshot-demo', source: 'demo', agentId: 'worker-demo', agentName: '시연 직원',
    projectId: 'project-demo', projectName: '시연 프로젝트' }),
];

test('approval-only floors remain discoverable and their worker can be reached', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot({ status: 'approval' })], events: [] }] });
  assert.match(ui.document.querySelector('[data-floor="project-live"]').textContent, /1명 확인 필요/u);
  assert.equal(ui.get('find-working').disabled, false);
  assert.equal(ui.get('active-count').textContent, '1');
  ui.click('#find-working');
  assert.equal(ui.get('employee-card').hidden, false);
  assert.match(ui.get('employee-detail').textContent, /원래 앱에서 승인/u);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
});

test('activity roster defaults to active staff, retains quiet staff in all, and updates after work ends', async t => {
  const ui = await mountOffice(t);
  assert.equal(ui.get('active-count').textContent, '1');
  ui.click('[data-open="team"]');
  assert.deepEqual([...ui.get('roster').querySelectorAll('[data-agent]')].map(button => button.dataset.agent), ['worker-live']);
  ui.click('[data-roster-filter="all"]');
  assert.equal(ui.get('roster').querySelectorAll('[data-agent]').length, 2);
  await ui.emit(snapshot({ id: 'work-ended', status: 'idle', timestamp: '2026-01-01T10:01:00.000Z' }));
  assert.equal(ui.get('active-count').textContent, '0');
  assert.equal(ui.get('staff-count').textContent, '2');
  ui.click('[data-roster-filter="active"]');
  assert.equal(ui.get('roster').querySelectorAll('[data-agent]').length, 0);
  assert.match(ui.get('roster').textContent, /전체 직원/u);
  ui.source.disconnect(); await ui.flush();
  assert.equal(ui.get('active-count').textContent, '—', 'a lost connection must not report a fresh activity count');
});

for (const focusTarget of ['#usage-card-claude', '#claude-usage-external-link']) {
  test(`usage updates preserve keyboard focus on ${focusTarget}`, async t => {
    const ui = await mountOffice(t, { usageFailsAfter: 1, usage: { providers: [{ provider: 'claude', status: 'live',
      updatedAt: timestamp, source: 'claude-statusline', windows: [
        { id: 'seven_day', label: 'Claude 주간', usedPercent: 34, windowMinutes: 10080, resetsAt: Date.parse(timestamp) / 1000 + 86400 },
      ] }] } });
    const cardFocus = focusTarget === '#usage-card-claude';
    if (!cardFocus) ui.click('.energy-tank.claude');
    const target = ui.document.querySelector(cardFocus ? '.energy-tank.claude' : '.usage-external-link');
    target.focus();
    assert.equal(ui.document.activeElement, target);
    ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
    assert.notEqual(ui.document.activeElement, target, 'failure changes the DOM and exercises focus restoration');
    assert.equal(ui.document.activeElement.id, focusTarget.slice(1));
  });
}

test('the full-name project selector keeps manual selection and building view has a distinct pressed state', async t => {
  const ui = await mountOffice(t);
  assert.equal(ui.get('building-cctv').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.get('project-select').options[1].textContent, '2F · 대기 프로젝트');
  ui.get('project-select').value = 'project-idle';
  ui.get('project-select').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  assert.equal(ui.get('room-title').textContent, '대기 프로젝트');
  assert.equal(ui.get('building-cctv').getAttribute('aria-pressed'), 'false');
  await ui.advance(90_000);
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  assert.equal(ui.get('room-title').textContent, '대기 프로젝트');
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  ui.click('#building-cctv'); ui.key('c');
  assert.equal(ui.get('building-cctv').getAttribute('aria-pressed'), 'false', 'automatic observation is not the manual building-view selection');
});

test('the building shot reports the HUD blocks around the stage so the scene fits the whole building between them', async t => {
  const ui = await mountOffice(t);
  assert.equal(ui.get('game').dataset.shot, 'building');
  const place = (selector, left, top, right, bottom) => {
    ui.document.querySelector(selector).getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top });
  };
  place('#game', 0, 0, 1280, 800);
  place('.top-hud', 28, 24, 1252, 74);
  place('.scene-location', 245, 113, 520, 209);
  place('.scene-hint', 490, 595, 790, 615);
  place('.bottom-hud', 380, 618, 900, 780);
  place('.floor-rail', 28, 151, 238, 575);
  // Mostly above the free band, so it does not narrow the stage; the camera tools beside the band do.
  place('.energy-hud', 1071, 89, 1252, 274);
  place('.camera-tools', 1200, 308, 1252, 492);
  ui.window.dispatchEvent(new ui.window.Event('resize')); await ui.flush();
  // Beside the caption the band starts under the top bar, so the usage HUD there covers enough of it to count as a right block.
  assert.deepEqual(ui.scene.hudInsets, { top: 209, right: 80, bottom: 205, left: 238, beside: { top: 74, right: 209, bottom: 205, left: 528 } },
    `measured ${JSON.stringify(ui.scene.hudInsets)}`);
  ui.document.querySelector('.scene-location').style.visibility = 'hidden';
  ui.window.dispatchEvent(new ui.window.Event('resize')); await ui.flush();
  assert.equal(ui.scene.hudInsets.top, 74, 'a hidden caption is not an inset');
  assert.equal(ui.scene.hudInsets.beside, null, 'nor a block to fit beside');
  ui.get('project-select').value = 'project-idle';
  ui.get('project-select').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  const reported = ui.scene.hudInsets;
  ui.document.querySelector('.scene-location').style.visibility = '';
  ui.window.dispatchEvent(new ui.window.Event('resize')); await ui.flush();
  assert.equal(ui.scene.hudInsets, reported, 'the office view measures nothing');
});

test('a narrow building shot reports the insets beside the floor caption under the project selector, and small caption width changes keep its edge', async t => {
  const ui = await mountOffice(t);
  const place = (selector, left, top, right, bottom) => {
    ui.document.querySelector(selector).getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top });
  };
  const measure = async () => { ui.window.dispatchEvent(new ui.window.Event('resize')); await ui.flush(); return ui.scene.hudInsets; };
  // Rects the built page lays out at 800x600 in the three-floor building shot; the camera tools sit under the usage HUD.
  place('#game', 0, 0, 800, 600);
  place('.top-hud', 21, 20, 779, 64);
  place('.project-select', 111, 91, 541, 127);
  place('.scene-location', 110, 139, 269, 226);
  place('.scene-hint', 250, 424, 550, 445);
  place('.bottom-hud', 90, 458, 710, 587);
  place('.floor-rail', 18, 117, 86, 440);
  place('.energy-hud', 627, 85, 782, 262);
  place('.camera-tools', 730, 274, 782, 457);
  assert.deepEqual(await measure(), { top: 226, right: 70, bottom: 176, left: 86, beside: { top: 127, right: 173, bottom: 176, left: 277 } },
    'below the caption the usage HUD is mostly above the band; beside it the band starts under the selector, the usage HUD counts and the edge keeps headroom');
  place('.scene-location', 110, 139, 262, 226);
  assert.equal((await measure()).beside.left, 277, 'a slightly narrower caption keeps the reported edge');
  place('.scene-location', 110, 139, 276, 226);
  assert.equal((await measure()).beside.left, 277, 'a caption wider by up to the headroom (a two-digit head count) keeps it too');
  place('.scene-location', 110, 139, 301.2, 226);
  assert.equal((await measure()).beside.left, 310, 'a wider caption past the headroom moves the edge at once, never left of the caption');
  place('.scene-location', 110, 139, 270, 226);
  assert.equal((await measure()).beside.left, 278, 'a caption narrower by more than the slack moves the edge back');
  // Usage arriving later changes the usage HUD's height; the building shot learns the new right block without a resize.
  place('.energy-hud', 627, 85, 782, 150);
  ui.click('#refresh-usage'); await ui.flush();
  assert.equal(ui.scene.hudInsets.beside.right, 70, 'a shorter usage HUD no longer narrows the band beside the caption');
  place('.energy-hud', 627, 85, 782, 262);
  ui.click('#refresh-usage'); await ui.flush();
  assert.equal(ui.scene.hudInsets.beside.right, 173, 'and a taller one does again');
  place('.scene-location', 110, 20, 269, 60);
  assert.equal((await measure()).beside, null, 'a caption that does not reach below the HUD above it offers no fit beside it');
});

test('the building shot publishes the usage HUD edge and the rail floor, and counts a tall building rail beside the camera tools', async t => {
  const ui = await mountOffice(t);
  const place = (selector, left, top, right, bottom) => {
    ui.document.querySelector(selector).getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top });
  };
  const measure = async () => { ui.window.dispatchEvent(new ui.window.Event('resize')); await ui.flush(); return ui.scene.hudInsets; };
  const game = ui.get('game');
  const rail = ui.document.createElement('ol');
  rail.className = 'building-floor-rail';
  ui.get('scene').append(rail);
  // Twelve floors at 1280x800: the rail sits under the usage HUD, left of the centred camera tools and outside the dock's column.
  place('#game', 0, 0, 1280, 800);
  place('.top-hud', 28, 24, 1252, 74);
  place('.scene-location', 245, 113, 520, 209);
  place('.scene-hint', 490, 596, 790, 616);
  place('.bottom-hud', 330, 618, 950, 780);
  place('.floor-rail', 28, 151, 238, 575);
  place('.energy-hud', 1071, 89, 1252, 273);
  place('.camera-tools', 1200, 308, 1252, 491);
  place('.building-floor-rail', 1002, 285, 1192, 604);
  const wide = await measure();
  assert.equal(game.style.getPropertyValue('--energy-bottom'), '273px', 'the camera tools and the rail follow the usage HUD edge');
  assert.equal(game.style.getPropertyValue('--rail-floor'), '0px', 'no bottom block shares the rail column');
  assert.equal(wide.right, 278, 'the rail beside the camera tools is the right block');
  // 800x600: the dock shares the slimmer rail's column, so the rail ends above it; the centred hint stays left of the rail.
  place('#game', 0, 0, 800, 600);
  place('.top-hud', 21, 20, 779, 64);
  place('.project-select', 111, 91, 541, 127);
  place('.scene-location', 110, 139, 269, 226);
  place('.scene-hint', 250, 424, 550, 445);
  place('.bottom-hud', 90, 458, 710, 587);
  place('.floor-rail', 18, 117, 86, 440);
  place('.energy-hud', 627, 85, 782, 262);
  place('.camera-tools', 730, 274, 782, 457);
  place('.building-floor-rail', 562, 274, 722, 446);
  const narrow = await measure();
  assert.equal(game.style.getPropertyValue('--rail-floor'), '142px');
  assert.deepEqual([narrow.right, narrow.beside.right], [238, 238], 'below and beside the caption the rail is the right block');
  rail.remove();
  await measure();
  assert.equal(game.style.getPropertyValue('--rail-floor'), '', 'a building without the rail publishes no rail floor');
  ui.click('[data-floor="project-live"]');
  assert.equal(game.dataset.shot, 'room');
  place('.energy-hud', 627, 85, 782, 300);
  await measure();
  assert.equal(game.style.getPropertyValue('--energy-bottom'), '300px', 'the office view keeps the camera tools under the usage HUD without an open card');
});

test('the camera tools and the elevator rail keep clear of the usage HUD, dock, news strip, hint, cards and each other at every window size', async () => {
  // A small cascade over style.css: top-level and @media width/height rules, exact selectors, specificity then source order.
  const css = (await readFile(new URL('style.css', sourceRoot), 'utf8')).replace(/\/\*[\s\S]*?\*\//gu, '');
  const rules = [];
  const parse = (from, to, media) => {
    for (let i = from; i < to;) {
      const open = css.indexOf('{', i);
      if (open < 0 || open >= to) break;
      const statement = css.indexOf(';', i);
      if (statement >= 0 && statement < open) { i = statement + 1; continue; }
      let depth = 1, end = open + 1;
      for (; depth > 0; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
      const prelude = css.slice(i, open).trim();
      if (prelude.startsWith('@media')) parse(open + 1, end - 1, [...media, prelude.slice(6)]);
      else if (!prelude.startsWith('@')) rules.push({ selectors: prelude.split(',').map(selector => selector.trim()), media, body: css.slice(open + 1, end - 1) });
      i = end;
    }
  };
  parse(0, css.length, []);
  const matches = (query, width, height) => query.split(',').some(part => [...part.matchAll(/\(([^)]*)\)/gu)].every(([, feature]) => {
    const bound = /^(min|max)-(width|height):(\d+)px$/u.exec(feature.trim());
    if (!bound) return false;
    const size = bound[2] === 'width' ? width : height;
    return bound[1] === 'min' ? size >= Number(bound[3]) : size <= Number(bound[3]);
  }));
  const declared = (selectors, width, height) => {
    const specificity = rule => Math.max(...rule.selectors.filter(selector => selectors.includes(selector)).map(selector => (selector.match(/[.[:]/gu) ?? []).length));
    const found = rules.map((rule, order) => ({ rule, order }))
      .filter(({ rule }) => rule.selectors.some(selector => selectors.includes(selector)) && rule.media.every(query => matches(query, width, height)))
      .sort((a, b) => specificity(a.rule) - specificity(b.rule) || a.order - b.order);
    const values = {};
    for (const { rule } of found) for (const declaration of rule.body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) values[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).replace('!important', '').trim();
    }
    return values;
  };
  const evaluate = (value, basis, vars, height) => {
    assert.equal(typeof value, 'string', 'the property is declared');
    let expression = value;
    for (let step = 0; expression.includes('var('); step++) {
      assert.ok(step < 40, `resolves ${value}`);
      // The last var() holds no other var(): a fallback may be one (var(--a,var(--b,1px))), so the innermost resolves first.
      const start = expression.lastIndexOf('var(');
      let depth = 0, end = start + 3, comma = -1;
      for (; end < expression.length; end++) {
        if (expression[end] === '(') depth++;
        else if (expression[end] === ')' && --depth === 0) break;
        else if (expression[end] === ',' && depth === 1 && comma < 0) comma = end;
      }
      const name = expression.slice(start + 4, comma < 0 ? end : comma).trim();
      const raw = vars[name] ?? (comma < 0 ? undefined : expression.slice(comma + 1, end));
      assert.notEqual(raw, undefined, `${name} is defined`);
      expression = `${expression.slice(0, start)}(${raw})${expression.slice(end + 1)}`;
    }
    const script = expression.replace(/calc\(/gu, '(').replace(/max\(/gu, 'Math.max(').replace(/min\(/gu, 'Math.min(')
      .replace(/(\d+(?:\.\d+)?)(px|%|dvh)?/gu, (_, number, unit) => String(unit === '%' ? number * basis / 100 : unit === 'dvh' ? number * height / 100 : Number(number)));
    assert.match(script, /^[\d\s.+\-*/(),Mathminx]*$/u, `computable ${value}`);
    return Function(`return ${script}`)();
  };
  // Twelve rail rows at 24px, the focus row at 30px, 1px gaps, 6px padding and the border.
  const RAIL_TWELVE_FLOORS = 11 * 24 + 30 + 11 + 12 + 2;
  const px = value => Number.parseFloat(value);
  const clear = (a, b) => Math.min(a[2], b[2]) <= Math.max(a[0], b[0]) || Math.min(a[3], b[3]) <= Math.max(a[1], b[1]);
  const round = rect => rect.map(value => Math.round(value)).join(',');
  // The markup's camera buttons and rules, so the size tokens fail once a control is added without them.
  const toolsMarkup = /<div class="hud camera-tools"[^>]*>([\s\S]*?)<\/div>/u.exec(await readFile(new URL('shell.ts', sourceRoot), 'utf8'))?.[1] ?? '';
  const toolButtons = (toolsMarkup.match(/<button\b/gu) ?? []).length, toolRules = (toolsMarkup.match(/<span><\/span>/gu) ?? []).length;
  assert.ok(toolButtons >= 4 && toolRules >= 1, `the camera tools markup has ${toolButtons} buttons and ${toolRules} rules`);
  // Crowded short windows: at 700x600 the dock shares the tools' column; 900x450 and 844x390 (a phone turned sideways) leave no room
  // for the tools between the usage HUD and the bottom blocks.
  for (const [width, height] of [[800, 600], [900, 700], [1000, 600], [1024, 768], [1280, 600], [1280, 800], [1440, 900], [375, 812], [700, 600], [900, 450], [844, 390]]) {
    for (const watching of [false, true]) for (const taller of [0, 48]) {
      const phone = width <= 650, short = height <= 650 && !phone, measuredCase = !watching && !taller;
      const label = `${width}x${height}${watching ? ' watching' : ''}${taller ? ' with a taller usage HUD' : ''}`;
      const style = selector => declared([selector, ...(watching ? [`.watching ${selector}`] : [])], width, height);
      const game = declared(['.game', ...(watching ? ['.game.watching'] : [])], width, height);
      const at = (value, basis, vars = game) => evaluate(value, basis, vars, height);
      // Usage HUD heights measured in the built page: 177px at 155px wide (800x600), 185px at 181px wide (1280x800); phones are estimated.
      const usageStyle = style('.energy-hud');
      const usageRight = width - at(usageStyle.right, width), usageTop = at(usageStyle.top, height);
      const usage = [usageRight - at(usageStyle.width, width), usageTop, usageRight, usageTop + (phone ? 190 : width <= 1000 ? 177 : 185) + taller];
      if (measuredCase && width === 800) assert.deepEqual(usage, [627, 85, 782, 262], 'the measured 800x600 usage HUD');
      if (measuredCase && width === 1280 && height === 800) assert.deepEqual(usage, [1071, 89, 1252, 274], 'the measured 1280x800 usage HUD');
      const vars = { ...game, '--energy-bottom': `${usage[3]}px` };
      // Bottom HUD 129px tall in short windows (measured at 800x600), 162px at 1280x800, estimated on phones; the building hint measured 300x21.
      const dockStyle = style('.bottom-hud'), dockWidth = at(dockStyle.width, width), dockBottom = height - at(dockStyle.bottom, height);
      const dock = [(width - dockWidth) / 2, dockBottom - (phone ? 145 : short ? 129 : 162), (width + dockWidth) / 2, dockBottom];
      const hintWidth = phone ? width - 24 : 300, hintBottom = height - at(style('.scene-hint').bottom, height);
      const hint = [(width - hintWidth) / 2, hintBottom - (phone ? 42 : 21), (width + hintWidth) / 2, hintBottom];
      const overlayStyle = style('.watch-overlay'), overlayBottom = height - at(overlayStyle.bottom, height);
      const overlay = [at(overlayStyle.left, width), overlayBottom - (phone ? 60 : 44), width - at(overlayStyle.right, width), overlayBottom];
      // A floating card never rises above the usage HUD; phones peek the card as a 120px bottom sheet.
      const cardStyle = style('.employee-card'), cardRight = phone ? width : width - at(cardStyle.right, width);
      const card = phone ? [0, height - 120, width, height] : [cardRight - at(cardStyle.width, width), usage[3] + 12, cardRight, height - at(cardStyle.bottom, height)];

      const box = declared(['.camera-tools'], width, height), button = declared(['.icon-button', '.camera-tools .icon-button'], width, height);
      const [ruleY, ruleX = ruleY] = declared(['.camera-tools>span'], width, height).margin.split(' ').map(px);
      const toolsStyle = style('.camera-tools'), row = toolsStyle['flex-direction'] === 'row';
      const across = 2 + 2 * px(box.padding) + px(row ? button.height : button.width);
      const along = 2 + 2 * px(box.padding) + toolButtons * px(row ? button.width : button.height) + toolRules * (1 + 2 * (row ? ruleX : ruleY));
      assert.deepEqual([at(vars['--camera-tools-width'], width, vars), at(vars['--camera-tools-height'], height, vars)], [across, along],
        `${label}: the size tokens match the camera buttons`);
      const [toolsWidth, toolsHeight] = row ? [along, across] : [across, along];
      const toolsRight = width - at(toolsStyle.right, width, vars), gap = at(vars['--right-column-gap'], height, vars);
      // main.ts publishes how far the bottom blocks sharing the tools' column reach up as --tools-clearance.
      const toolsFloor = Math.max(0, ...(watching ? [overlay] : [dock, hint]).filter(block => block[0] < toolsRight && block[2] > toolsRight - toolsWidth)
        .map(block => height - block[1]));
      const toolsVars = { ...vars, '--tools-clearance': `${toolsFloor}px` };
      const toolsTop = toolsStyle.top !== 'auto' ? at(toolsStyle.top, height, toolsVars) : height - at(toolsStyle.bottom, height, toolsVars) - toolsHeight;
      assert.equal(/translate/u.test(toolsStyle.transform ?? ''), false, `${label}: the tools are placed without a transform`);
      const tools = [toolsRight - toolsWidth, toolsTop, toolsRight, toolsTop + toolsHeight];
      assert.ok(tools[0] >= 0 && tools[1] >= 0 && tools[2] <= width && tools[3] <= height, `${label}: camera tools ${round(tools)} stay on screen`);
      // Where no room is left between the usage HUD and the bottom blocks, every camera button stays usable over the usage HUD's
      // lower edge instead of hiding under it.
      if (!clear(tools, usage)) {
        assert.ok(usage[3] + gap + toolsHeight + gap + toolsFloor > height, `${label}: camera tools ${round(tools)} cover the usage HUD ${round(usage)} only without room under it`);
        assert.ok(Number(toolsStyle['z-index']) > Number(style('.energy-hud')['z-index']), `${label}: the camera tools draw over the usage HUD`);
      }
      // In windows up to 560px high a card is a sheet in the right column, drawn over the tools by design.
      const sheet = !phone && height <= 560;
      for (const [name, block] of Object.entries(watching ? { overlay } : { dock, hint, ...(sheet ? {} : { card }) })) {
        assert.ok(clear(tools, block), `${label}: camera tools ${round(tools)} clear the ${name} ${round(block)}`);
      }

      const railStyle = style('.building-floor-rail');
      const railRight = width - at(railStyle.right, width, vars), railLeft = railRight - at(railStyle.width, width, vars);
      // main.ts publishes the bottom blocks that share the rail's column as --rail-floor.
      const sharing = (watching ? [overlay] : [dock, hint]).filter(block => block[0] < railRight && block[2] > railLeft);
      const railFloor = Math.max(0, ...sharing.map(block => height - block[1]));
      const railVars = { ...vars, '--rail-floor': `${railFloor}px` };
      const railTop = at(railStyle.top, height, railVars);
      const rail = [railLeft, railTop, railRight, railTop + Math.min(RAIL_TWELVE_FLOORS, at(railStyle['max-height'], height, railVars))];
      // A window too short for two rail rows above the bottom blocks of the rail's column (900x450) keeps the rail's scrolling
      // minimum there; the floor list still names every floor.
      const toolsRowFloor = vars['--tools-floor'] ? at(vars['--tools-floor'], height, railVars) : 0;
      if (height - railTop - gap - Math.max(railFloor, toolsRowFloor) < 62) continue;
      assert.ok(rail[0] >= 0 && rail[3] - rail[1] >= 62, `${label}: the rail ${round(rail)} stays on screen with at least two floors`);
      for (const [name, block] of Object.entries(watching ? { usage, tools, overlay } : { usage, tools, dock, hint })) {
        assert.ok(clear(rail, block), `${label}: the rail ${round(rail)} clears the ${name} ${round(block)}`);
      }
      if (measuredCase && width === 800) assert.deepEqual(tools, [730, 274, 782, 457], 'at 800x600 the zoom button leaves the usage HUD');
      if (measuredCase && width === 1280 && height === 800) {
        assert.deepEqual(tools, [1200, 308.5, 1252, 491.5], 'a tall window keeps the camera tools centred');
        assert.deepEqual(rail, [1002, 286, 1192, 286 + RAIL_TWELVE_FLOORS], 'twelve floors fit under the usage HUD');
      }
    }
  }
});

test('Claude cards focus Claude details and local refresh preserves stale evidence and official recovery link', async t => {
  const observed = '2026-01-01T09:00:00.000Z';
  const ui = await mountOffice(t, { usage: { providers: [{ provider: 'claude', status: 'stale',
    updatedAt: observed, source: 'claude-statusline', reason: 'outdated', windows: [
      { id: 'seven_day', label: 'Claude 주간', usedPercent: 34, windowMinutes: 10080, resetsAt: Date.parse(timestamp) / 1000 + 86400 },
    ] }] } });
  ui.click('.energy-tank.claude');
  assert.equal(ui.document.activeElement.id, 'usage-provider-claude');
  assert.equal(ui.get('refresh-usage').textContent.trim(), '수신 내용 새로고침');
  const card = () => ui.document.querySelector('.energy-tank.claude');
  assert.equal(card().querySelector('.energy-record-tag').textContent, '마지막 기록');
  const label = card().getAttribute('aria-label');
  const link = ui.get('usage-provider-claude').querySelector('a');
  assert.equal(link.href, 'https://claude.ai/settings/usage');
  assert.equal(link.target, '_blank');
  ui.click('#refresh-usage'); await ui.flush();
  assert.equal(card().getAttribute('aria-label'), label);
  assert.ok(card().classList.contains('aged'));
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
});

async function mountOffice(t, { url = 'http://127.0.0.1:4780/', states, savedSettings,
  autoConnect = true, stateError = false, initiallyHidden = false, usage = { providers: [] }, usageFailsAfter = Infinity,
  personalSettings = { companyName: '테스트 사무실', ownerName: '예시 사장' }, settingsSaveError = false, systemReducedMotion = false,
  instructionPlanes = false, buildingIntro = '' } = {}) {
  const window = new Window({ url });
  const motionPreference = new window.EventTarget();
  motionPreference.matches = systemReducedMotion;
  if (initiallyHidden) {
    Object.defineProperty(window.document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'hidden' });
  }
  window.document.body.innerHTML = '<div id="app"></div>';
  if (savedSettings) window.localStorage.setItem('agent-office.view.v1', JSON.stringify(savedSettings));
  const directory = await mkdtemp(join(tmpdir(), 'agent-office-ui-'));
  const calls = [];
  const frames = [];
  const sources = [];
  const requests = [];
  const settingsWrites = [];
  const intervals = new Map();
  let intervalId = 0;
  let now = Date.parse(timestamp);
  let scene;
  let stateRequests = 0;
  let usageRequests = 0;
  const snapshots = states ?? [{ agents: initialSnapshots(), events: [] }];

  class OfficeScene {
    constructor(element, select, selectFloor) { this.element = element; this.select = select; this.selectFloor = selectFloor; scene = this; }
    setAgents(agents) { this.agents = agents.map(agent => ({ ...agent })); }
    setBuildingFloors(floors) { this.buildingFloors = floors.map(floor => ({ ...floor, agents: floor.agents.map(agent => ({ ...agent })) })); }
    setBuildingView(enabled, projectId = '') {
      if (this.buildingView !== enabled || this.buildingProject !== projectId) this.zoomLevel = 1;
      this.buildingView = enabled; this.buildingProject = projectId; this.element.dataset.view = enabled ? 'building' : 'office';
      // Kept out of `calls`; records each shot with the motion setting in effect when it was requested.
      this.buildingViewHistory = [...(this.buildingViewHistory ?? []), [enabled, projectId, this.reducedMotion === true]];
    }
    hasVisibleAgent(id) { return this.buildingView ? (this.buildingFloors ?? []).some(floor => floor.agents.some(agent => agent.id === id)) : (this.agents ?? []).some(agent => agent.id === id); }
    resetCamera() { calls.push(['resetCamera']); this.zoomLevel = 1; }
    focus(id, options) { calls.push(options ? ['focus', id, options] : ['focus', id]); this.zoomLevel = 1; }
    stopFollowing() { calls.push(['stopFollowing']); }
    zoom(amount) { calls.push(['zoom', amount]); this.zoomLevel = Math.max(.35, (this.zoomLevel ?? 1) + amount); }
    isZoomedIn() { return (this.zoomLevel ?? 1) > 1.05; }
    setLabelsVisible(value) { this.labels = value; }
    setActivityBubblesVisible(value) { this.bubbles = value; }
    setReducedMotion(value) { this.reducedMotion = value; }
    setAutoRotate(value) { this.autoRotate = value; }
    setPowerSaving(value) { this.powerSaving = value; }
    setPaused(value) { this.paused = value; }
    deliver(from, to) { calls.push(['deliver', from, to]); }
    sendPaperPlane(from, to, eventId) {
      if (this.buildingView || !this.hasVisibleAgent(from) || !this.hasVisibleAgent(to)) return false;
      calls.push(['sendPaperPlane', from, to, eventId]); return true;
    }
    sendBuildingPaperPlane(from, to, eventId) {
      if (!this.buildingView || this.reducedMotion || !this.hasVisibleAgent(from) || !this.hasVisibleAgent(to)) return false;
      calls.push(['sendBuildingPaperPlane', from, to, eventId]); return true;
    }
    sendMessagePlane(agentId, eventId) {
      if (this.reducedMotion || this.paused || !this.hasVisibleAgent(agentId)) return false;
      calls.push(['sendMessagePlane', agentId, eventId]); return true;
    }
    stamp(id) { calls.push(['stamp', id]); }
    // Kept out of `calls` so existing "last camera call" assertions keep their meaning.
    setCardOpen(id) { this.cardOpen = id; this.cardOpenHistory = [...(this.cardOpenHistory ?? []), id]; }
    setOwnerNames(names) { this.ownerNames = { ...names }; }
    setBridgeConnected(value) { this.bridgeHistory = [...(this.bridgeHistory ?? []), value]; }
    pulseRouter() { this.routerPulses = (this.routerPulses ?? 0) + 1; }
    // Kept out of `calls`; the owner desk tray receives the company-wide approval request count on every render.
    setApprovalCount(count) { this.approvalCount = count; }
    // Kept out of `calls`; the building shot's measured HUD insets.
    setHudInsets(insets) { this.hudInsets = { ...insets }; }
    requestApproval(id) { calls.push(['requestApproval', id]); }
    resolveApproval(id) { calls.push(['resolveApproval', id]); }
    dispose() { this.disposed = true; }
  }
  // Scenes built before the 3D branch lands have no owner-desk flight; tests opt in to exercise it.
  if (instructionPlanes) OfficeScene.prototype.sendInstructionPlane = function (toAgentId, eventId) {
    // Like the real scene, a recipient whose desk is kept without a drawn character cannot receive the owner plane.
    if (this.buildingView || this.reducedMotion || this.instructionCooldown || !this.hasVisibleAgent(toAgentId)
      || (this.agents ?? []).some(agent => agent.id === toAgentId && agent.showCharacter === false)) return false;
    calls.push(['sendInstructionPlane', toAgentId, eventId]); return true;
  };
  // Scenes may offer a dedicated building intro ('play') or refuse it ('refuse'); without the option the UI uses its fallback.
  if (buildingIntro) OfficeScene.prototype.playBuildingIntro = function (fromProjectId, durationMs) {
    this.introHistory = [...(this.introHistory ?? []), [fromProjectId, durationMs, this.reducedMotion === true]];
    if (buildingIntro === 'refuse') return false;
    this.setBuildingView(true); return true;
  };
  class EventSource {
    constructor(path) { this.path = path; sources.push(this); }
    open() { this.onopen?.({}); }
    disconnect() { this.onerror?.({}); }
    message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
    close() { this.closed = true; }
  }
  const fetch = async (path, options) => {
    requests.push(path);
    if (path === '/api/settings') {
      if (options?.method === 'PATCH') {
        settingsWrites.push(JSON.parse(options.body));
        if (settingsSaveError) return { ok: false, json: async () => ({}) };
        personalSettings = { ...personalSettings, ...JSON.parse(options.body) };
      }
      return { ok: true, json: async () => ({ ...personalSettings }) };
    }
    if (path === '/api/usage') {
      if (usageRequests++ >= usageFailsAfter) throw new Error('Usage endpoint unavailable');
      return { ok: true, json: async () => structuredClone(usage) };
    }
    if (path === '/api/state') {
      const attempt = stateRequests++;
      if (stateError && attempt === 0) throw new Error('Initial state request unavailable');
      const state = snapshots[Math.min(attempt, snapshots.length - 1)];
      return { ok: true, json: async () => structuredClone(state) };
    }
    throw new Error(`Unexpected UI request: ${path}`);
  };
  const globals = {
    window, document: window.document, HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement, CSS: window.CSS,
    location: window.location, localStorage: window.localStorage,
    matchMedia: query => query === '(prefers-reduced-motion: reduce)' ? motionPreference : window.matchMedia(query), EventSource, fetch,
    requestAnimationFrame: callback => frames.push(callback),
    setInterval: (callback, delay, ...args) => {
      const id = ++intervalId;
      const period = Math.max(1, Number(delay) || 1);
      intervals.set(id, { callback, args, period, next: now + period });
      return id;
    },
    clearInterval: id => intervals.delete(id),
    __officeSceneForTest: OfficeScene,
  };
  const originalNow = Object.getOwnPropertyDescriptor(Date, 'now');
  Object.defineProperty(Date, 'now', { ...originalNow, value: () => now });
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(async () => {
    window.dispatchEvent(new window.Event('pagehide'));
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    Object.defineProperty(Date, 'now', originalNow);
    await rm(directory, { recursive: true, force: true });
  });

  // TypeScript 7 does not expose transpileModule; the project's Node baseline can
  // strip these erasable types. Imports retain the production module boundaries.
  for (const name of ['main', 'shell', 'company-settings', 'protocol', 'status-style', 'work-activity', 'activity-freshness', 'appearance', 'portrait', 'office-state', 'observation', 'view-settings', 'camera-director', 'building-director', 'handoff-playback', 'usage-view', 'usage-ui']) {
    const source = await readFile(new URL(`${name}.ts`, sourceRoot), 'utf8');
    const code = stripTypeScriptTypes(source, { mode: 'strip' })
      .replace(/^import\s+['"][^'"]+\.css['"];\s*/gmu, '')
      .replace(/from\s+(['"])(\.[^'"]+)\1/gu, (_match, quote, path) =>
        `from ${quote}${path.endsWith('.mjs') ? new URL(path, sourceRoot).href : `${path.replace(/\.ts$/u, '')}.mjs`}${quote}`);
    await writeFile(join(directory, `${name}.mjs`), code);
  }
  await writeFile(join(directory, 'office-scene.mjs'), 'export const OfficeScene = globalThis.__officeSceneForTest;\n');
  await import(pathToFileURL(join(directory, 'main.mjs')).href);
  const flush = async () => {
    // Drain the mocked fetch promise chain and explicitly scheduled render frames.
    for (let step = 0; step < 16; step++) {
      await Promise.resolve();
      for (const frame of frames.splice(0)) frame(0);
    }
  };
  await flush();
  assert.equal(sources.length, 1, 'one SSE connection is created');
  const source = sources[0];
  assert.equal(source.path, '/api/events');
  if (autoConnect) { source.open(); await flush(); }
  return {
    window, document: window.document, scene, source, calls, requests, settingsWrites, flush,
    setSystemReducedMotion: async value => { motionPreference.matches = value; motionPreference.dispatchEvent(new window.Event('change')); await flush(); },
    get stateRequests() { return stateRequests; },
    get: id => window.document.getElementById(id),
    click: selector => { const button = window.document.querySelector(selector); assert.ok(button, selector); button.click(); },
    selectSession: value => {
      const selector = window.document.getElementById('session-select');
      selector.value = value; selector.dispatchEvent(new window.Event('change', { bubbles: true }));
    },
    key: (key, target = window.document.body) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    emit: async event => { source.message(event); await flush(); },
    setHidden: async value => {
      Object.defineProperty(window.document, 'hidden', { configurable: true, value });
      Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: value ? 'hidden' : 'visible' });
      window.document.dispatchEvent(new window.Event('visibilitychange')); await flush();
    },
    advance: async milliseconds => {
      const until = now + milliseconds;
      while (intervals.size) {
        const next = Math.min(...[...intervals.values()].map(interval => interval.next));
        if (next > until) break;
        now = next;
        for (const interval of [...intervals.values()]) if (interval.next <= now) {
          interval.next += interval.period;
          interval.callback(...interval.args);
        }
        await flush();
      }
      now = until;
      await flush();
    },
  };
}

test('live snapshots produce only connected floors, and menus open as named dialogs', async t => {
  const ui = await mountOffice(t);
  assert.equal(ui.get('game').classList.contains('watching'), false);
  assert.equal(ui.get('watch-overlay').hidden, true);
  assert.equal(ui.get('staff-count').textContent, '2');
  assert.deepEqual([...ui.document.querySelectorAll('[data-floor]')].map(button => button.dataset.floor), ['project-live', 'project-idle']);
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss', 'worker-live']);
  assert.equal(ui.get('room-title').textContent, '실제 프로젝트');
  ui.click('[data-open="team"]');
  const panel = ui.get('office-panel');
  assert.equal(panel.open, true);
  assert.equal(ui.document.getElementById(panel.getAttribute('aria-labelledby')).textContent, '우리 직원들');
  assert.equal(ui.get('game').contains(panel), true, 'the dialog is inside the fullscreen root');
  assert.equal(ui.get('game').contains(ui.get('toast')), true, 'status messages are inside the fullscreen root');
  ui.click('[data-roster-filter="all"]');
  assert.deepEqual([...ui.get('roster').querySelectorAll('[data-agent]')].map(button => button.dataset.agent), ['worker-live', 'worker-idle']);
  ui.click('#close-panel');
  assert.equal(panel.open, false);
  ui.click('[data-floor="project-idle"]');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss']);
});

test('incoming work preserves a zoomed camera and keyboard focus in a changing roster', async t => {
  const ui = await mountOffice(t);
  ui.click('#zoom-in');
  assert.deepEqual(ui.calls.filter(call => call[0] === 'zoom').at(-1), ['zoom', .3]);
  assert.deepEqual(ui.calls.at(-1), ['stopFollowing'], 'manual zoom releases automatic employee tracking');
  const afterZoom = ui.calls.length;
  await ui.emit(snapshot({ id: 'next-working', timestamp: '2026-01-01T10:01:00.000Z', title: '새 도구 사용', status: 'reviewing' }));
  assert.equal(ui.calls.slice(afterZoom).some(call => call[0] === 'resetCamera' || (call[0] === 'focus' && call[1] === null)), false,
    'an ordinary SSE update must not undo the user camera');
  ui.click('[data-open="team"]');
  const oldButton = ui.get('roster').querySelector('[data-agent="worker-live"]');
  oldButton.focus();
  assert.equal(ui.document.activeElement, oldButton);
  await ui.emit(snapshot({ id: 'next-approval', timestamp: '2026-01-01T10:02:00.000Z', title: '확인 대기', status: 'approval' }));
  const currentButton = ui.get('roster').querySelector('[data-agent="worker-live"]');
  assert.notEqual(currentButton, oldButton, 'the changed status actually exercises DOM replacement');
  assert.equal(ui.document.activeElement, currentButton, 'the same employee retains keyboard focus');
  currentButton.click();
  assert.equal(ui.get('office-panel').open, false);
  assert.equal(ui.get('employee-card').hidden, false);
  assert.deepEqual(ui.calls.at(-1), ['focus', 'worker-live']);
  assert.match(ui.get('employee-detail').textContent, /확인 대기/u);
});

test('settings and CCTV keys work while disconnect/reconnect preserves stale data and applies departures', async t => {
  const retired = snapshot({ id: 'later-retirement', timestamp: '2026-01-01T10:03:00.000Z', type: 'agent.retired', retired: true });
  const ui = await mountOffice(t, { states: [
    { agents: initialSnapshots(), events: [] },
    { agents: [retired, initialSnapshots()[1]], events: [retired] },
  ] });
  ui.click('[data-open="settings"]');
  const labels = ui.get('setting-labels');
  labels.checked = false;
  labels.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  assert.equal(ui.scene.labels, false);
  assert.equal(JSON.parse(ui.window.localStorage.getItem('agent-office.view.v1')).labels, false);
  assert.match(ui.get('settings-saved').textContent, /저장했어요/u);
  ui.key('c', labels);
  assert.equal(ui.get('game').classList.contains('watching'), false, 'typing on a form control does not trigger CCTV');
  ui.click('#close-panel');
  ui.key('c');
  assert.equal(ui.get('watch-overlay').hidden, false);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'true');
  ui.key('Escape');
  assert.equal(ui.get('watch-overlay').hidden, true);

  ui.source.disconnect(); await ui.flush();
  assert.equal(ui.scene.paused, true);
  assert.equal(ui.get('game').classList.contains('disconnected'), true);
  assert.equal(ui.get('connection-notice').hidden, false);
  assert.match(ui.get('connection-notice').textContent, /마지막 상태/u);
  assert.equal(ui.get('staff-count').textContent, '2', 'connection loss alone does not fabricate departures');
  ui.source.open(); await ui.flush();
  assert.equal(ui.stateRequests, 2, 'reconnection reloads the current snapshot');
  assert.equal(ui.scene.paused, false);
  assert.equal(ui.get('connection-notice').hidden, true);
  assert.equal(ui.get('staff-count').textContent, '1');
  assert.deepEqual([...ui.document.querySelectorAll('[data-floor]')].map(button => button.dataset.floor), ['project-idle']);
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss']);
});

test('CCTV advances after 25 seconds, postpones for camera input, and holds while paused or reading a panel', async t => {
  const snapshots = initialSnapshots(); snapshots[1].status = 'working';
  const ui = await mountOffice(t, { states: [{ agents: snapshots, events: [] }] });
  const currentFloor = () => ui.get('room-title').textContent;
  ui.key('c');
  assert.equal(ui.scene.buildingView,true);
  await ui.advance(9999); assert.equal(ui.scene.buildingView,true,'the initial ten-second shot includes the whole building');
  await ui.advance(1); assert.equal(ui.scene.buildingView,false,'the wide shot leads into the selected office');
  await ui.advance(14_999);
  assert.equal(currentFloor(), '실제 프로젝트', 'the current room gets its full dwell time');
  await ui.advance(1);
  assert.equal(currentFloor(), '대기 프로젝트', 'the timer visits the other working room');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss', 'worker-idle']);

  await ui.advance(20_000);
  ui.get('scene').dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true }));
  await ui.advance(5_000);
  assert.equal(currentFloor(), '대기 프로젝트', 'manual camera input postpones the previous deadline');
  await ui.advance(19_999);
  assert.equal(currentFloor(), '대기 프로젝트');
  await ui.advance(1);
  assert.equal(currentFloor(), '실제 프로젝트', 'rotation resumes 25 seconds after manual input');

  ui.key('Escape');
  ui.click('[data-open="settings"]');
  ui.click('#pause');
  ui.click('#close-panel');
  ui.key('c');
  await ui.advance(60_000);
  assert.equal(ui.scene.paused, true);
  assert.equal(currentFloor(), '실제 프로젝트', 'paused observation does not rotate');
  assert.match(ui.get('cycle-status').textContent, /일시정지/u);

  ui.key('Escape');
  ui.click('[data-open="settings"]');
  ui.click('#pause');
  ui.click('#close-panel');
  ui.key('c');
  await ui.advance(35_000);
  assert.equal(currentFloor(), '대기 프로젝트');
  ui.scene.select('worker-idle');
  ui.click('#employee-detail [data-open="communications"]');
  assert.equal(ui.get('office-panel').open, true);
  await ui.advance(50_000);
  assert.equal(currentFloor(), '대기 프로젝트', 'reading a panel holds the current CCTV room');
  ui.click('#close-panel');
  ui.click('#building-cctv');
  await ui.advance(60_000);
  assert.equal(currentFloor(), '대기 프로젝트', 'returning outside alone does not restart observation');
  // This test spans more than five minutes. Renew actual work so it continues to
  // test the camera's dwell policy instead of the separate freshness boundary.
  for (const employee of snapshots.slice(0, 2)) {
    await ui.emit({ ...employee, id: `${employee.id}-still-working`, timestamp: new Date(Date.now()).toISOString() });
  }
  ui.key('c');
  await ui.advance(35_000);
  assert.equal(currentFloor(), '실제 프로젝트', 'explicit observation starts a fresh dwell period');
});

test('manual floor selection survives focus changes and elapsed time until observation is explicitly enabled', async t => {
  const workers = [snapshot(), snapshot({ id: 'room-two', agentId: 'worker-two', sessionId: 'session-two' }),
    snapshot({ id: 'other-floor', agentId: 'worker-three', projectId: 'project-other', projectName: '다른 층', sessionId: 'session-three' })];
  const ui = await mountOffice(t, { states: [{ agents: workers, events: [] }] });
  assert.equal(ui.get('game').dataset.cameraScope, 'building');
  ui.click('[data-floor="project-live"]');
  ui.selectSession('session-live');
  assert.equal(ui.get('game').dataset.cameraScope, 'floor');
  const selectedSession = ui.get('session-select').value;
  const cameraCalls = ui.calls.length;
  ui.window.dispatchEvent(new ui.window.Event('blur')); await ui.flush();
  assert.equal(ui.get('game').dataset.cameraScope, 'floor');
  await ui.advance(90_000);
  await ui.setHidden(true); await ui.setHidden(false);
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  assert.equal(ui.get('session-select').value, selectedSession);
  assert.equal(ui.get('room-title').textContent, '실제 프로젝트');
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.scene.autoRotate, false);
  assert.equal(ui.calls.slice(cameraCalls).some(call => call[0] === 'focus' || call[0] === 'resetCamera'), false);
  ui.click('#watch-toggle');
  await ui.advance(25_000);
  assert.equal(ui.get('session-select').value, 'session-three', 'explicit observation resumes the building-wide tour instead of retaining a manual floor filter');
  assert.equal(ui.get('room-title').textContent, '다른 층');
  ui.click('#building-cctv');
  assert.equal(ui.get('game').dataset.cameraScope, 'building');
  assert.equal(ui.get('employee-card').hidden, true);
});

test('observation chooses current activity, skips quiet floors and waits for new work without touring empty desks', async t => {
  const quiet = snapshot({ id: 'quiet', agentId: 'quiet-worker', status: 'idle',
    projectId: 'quiet-project', projectName: '대기 층', sessionId: 'quiet-chat' });
  const ui = await mountOffice(t, { states: [{ agents: [quiet, snapshot()], events: [] }] });
  ui.click('[data-floor="quiet-project"]'); ui.click('#building-cctv');
  ui.key('c');
  assert.equal(ui.get('room-title').textContent, '실제 프로젝트', 'starting observation leaves a quiet preview for actual activity');
  assert.equal(ui.scene.buildingView, false, 'one active floor goes straight to its office');
  for (let step = 0; step < 8; step++) {
    await ui.advance(25_000);
    assert.equal(ui.get('room-title').textContent, '실제 프로젝트');
    assert.equal(ui.scene.buildingView, false, 'quiet floors cannot cause periodic building tours');
  }
  assert.ok(ui.calls.some(call => call[0] === 'focus' && call[1] === 'worker-live'));
  await ui.emit(snapshot({ id: 'finished', status: 'idle', timestamp: new Date(Date.now()).toISOString() }));
  await ui.advance(1000);
  assert.match(ui.get('cycle-status').textContent, /작업 중인 직원을 기다리는 중/u);
  assert.equal(ui.scene.autoRotate, false);
  const quietStart = ui.calls.length;
  await ui.advance(90_000);
  assert.equal(ui.calls.slice(quietStart).some(call => ['focus', 'resetCamera'].includes(call[0])), false);
  await ui.emit({ ...quiet, id: 'quiet-now-busy', status: 'working', timestamp: new Date(Date.now()).toISOString() });
  await ui.advance(1000);
  assert.equal(ui.get('room-title').textContent, '대기 층', 'the floor becomes eligible when actual work arrives');
  assert.equal(ui.scene.autoRotate, true);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'true');
  await ui.advance(30_000);
  assert.ok(ui.calls.some(call => call[0] === 'focus' && call[1] === 'quiet-worker'));
  ui.click('#zoom-in');
  const manualStart = ui.calls.length;
  await ui.emit(snapshot({ id: 'manual-busy-elsewhere', status: 'working', timestamp: new Date(Date.now()).toISOString() }));
  await ui.setHidden(true); await ui.setHidden(false); await ui.advance(90_000);
  assert.equal(ui.get('room-title').textContent, '대기 층');
  assert.equal(ui.scene.autoRotate, false);
  assert.equal(ui.calls.slice(manualStart).some(call => ['focus', 'resetCamera'].includes(call[0])), false);
});

test('observation keeps its camera controls visible and usable without making manual views automatic', async t => {
  const ui = await mountOffice(t);
  const style = ui.document.createElement('style');
  style.textContent = (await readFile(new URL('style.css', sourceRoot), 'utf8')).replace(/^@import[^;]+;/gmu, '');
  ui.document.head.append(style);
  const cameraTools = ui.get('orbit').closest('.camera-tools');
  const styleOf = element => ui.window.getComputedStyle(element);
  ui.click('#watch-toggle');
  assert.notEqual(styleOf(cameraTools).visibility, 'hidden', 'observation must expose the controls needed to adjust it');
  assert.notEqual(styleOf(cameraTools).pointerEvents, 'none');
  assert.equal(styleOf(ui.document.querySelector('.top-hud')).visibility, 'hidden', 'the remaining HUD still stays out of the view');
  assert.equal(ui.get('orbit').disabled, false);
  assert.equal(ui.get('orbit').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.scene.autoRotate, true);
  ui.click('#orbit');
  assert.equal(ui.scene.autoRotate, false);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.get('setting-autoRotate').checked, false);
  assert.equal(JSON.parse(ui.window.localStorage.getItem('agent-office.view.v1')).autoRotate, false);
  ui.click('#orbit');
  assert.equal(ui.scene.autoRotate, true);
  ui.click('#zoom-in');
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.get('orbit').disabled, true);
  assert.match(ui.get('orbit').title, /관찰 모드를 켜면/u);
  assert.equal(ui.scene.autoRotate, false);
  ui.window.dispatchEvent(new ui.window.Event('blur'));
  await ui.setHidden(true); await ui.setHidden(false);
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  await ui.advance(60_000);
  assert.equal(ui.scene.autoRotate, false);
  ui.key('c');
  assert.equal(ui.scene.autoRotate, true);
  assert.equal(ui.get('orbit').disabled, false);
});

test('desktop startup and manual inspection never implicitly start observation, even with legacy preferences', async t => {
  const ui = await mountOffice(t, { url: 'http://127.0.0.1:4780/?watch=1&desktop=1',
    savedSettings: { awayCctv: true, autoRotate: true, followWork: true, cycle: true } });
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.scene.autoRotate, false);
  ui.click('#watch-toggle');
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.scene.autoRotate, true);
  ui.scene.selectFloor('project-live');
  ui.click('#zoom-in');
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  const zoom = ui.scene.zoomLevel;
  const cameraCalls = ui.calls.length;
  ui.window.dispatchEvent(new ui.window.Event('blur')); await ui.flush();
  await ui.advance(120_000);
  assert.equal(ui.scene.zoomLevel, zoom);
  assert.equal(ui.get('room-title').textContent, '실제 프로젝트');
  assert.equal(ui.calls.slice(cameraCalls).some(call => call[0] === 'focus' || call[0] === 'resetCamera'), false);
  ui.click('#zoom-out');
  await ui.advance(60_000);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false', 'zoom-out does not authorize observation');
});

test('legacy watch URLs and separate windows start with observation off', async t => {
  const ui = await mountOffice(t, { url: 'http://127.0.0.1:4780/?watch=1' });
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.scene.autoRotate, false);
});

test('manual building overview stays wide through incoming work, focus refresh and visibility changes', async t => {
  const ui = await mountOffice(t);
  ui.click('#building-cctv');
  const cameraCalls = ui.calls.length;
  await ui.advance(60_000);
  await ui.emit(snapshot({ id: 'manual-building-update', status: 'working' }));
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  await ui.setHidden(true); await ui.setHidden(false);
  assert.equal(ui.scene.buildingProject, '');
  assert.equal(ui.scene.buildingView, true);
  assert.equal(ui.get('location-project').textContent, '테스트 사무실');
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.calls.slice(cameraCalls).some(call => call[0] === 'focus' || call[0] === 'resetCamera'), false);
});

test('building PageUp and PageDown hold automation before the scene starts its floor glide, other camera keys after the scene', async t => {
  const ui = await mountOffice(t);
  ui.click('#building-cctv');
  assert.equal(ui.scene.buildingView, true);
  // Stands in for the canvas: the real scene reads camera keys on its canvas inside #scene and starts a floor glide there,
  // which a later manual hold (stopFollowing) would cancel.
  const canvas = ui.document.createElement('div');
  ui.get('scene').append(canvas);
  canvas.addEventListener('keydown', event => ui.calls.push(['canvasKey', event.key]));
  const order = key => {
    const from = ui.calls.length;
    ui.key(key, canvas);
    const names = ui.calls.slice(from).map(call => call[0]);
    return { names, canvas: names.indexOf('canvasKey'), lastHold: names.lastIndexOf('stopFollowing') };
  };
  for (const key of ['PageDown', 'PageUp']) {
    const step = order(key);
    assert.ok(step.canvas >= 0 && step.lastHold >= 0, `${key} reaches the canvas and holds automation (${step.names.join()})`);
    assert.ok(step.lastHold < step.canvas, `${key}: no manual hold follows the scene's glide (${step.names.join()})`);
  }
  const orbit = order('ArrowLeft');
  assert.ok(orbit.canvas >= 0 && orbit.lastHold > orbit.canvas, `an orbit key is held after the scene applied it (${orbit.names.join()})`);
});

test('a zoomed view and zoom-out stay manual until observation is explicitly started', async t => {
  const workers = [snapshot(), snapshot({ id: 'room-two', agentId: 'worker-two', sessionId: 'session-two' }),
    snapshot({ id: 'other-floor', agentId: 'worker-three', projectId: 'project-other', projectName: '다른 층', sessionId: 'session-three' })];
  const ui = await mountOffice(t, { states: [{ agents: workers, events: [] }] });
  ui.click('[data-floor="project-live"]');
  ui.click('#zoom-in');
  assert.equal(ui.get('game').dataset.zoomLock, 'true');
  const session = ui.get('session-select').value;
  const focusCalls = () => ui.calls.filter(call => call[0] === 'focus').length;
  const focusBefore = focusCalls();
  await ui.advance(90_000);
  assert.equal(ui.get('session-select').value, session, 'room rotation waits while the user keeps a zoomed view');
  assert.equal(focusCalls(), focusBefore, 'work following does not move a zoomed view');
  assert.match(ui.get('cycle-status').textContent, /선택한 화면 유지/u);
  assert.match(ui.get('toast').textContent, /관찰 모드를 켜주세요/u, 'manual inspection explains how to resume observation');
  await ui.emit(snapshot({ id: 'locked-handoff', type: 'handoff', agentId: 'worker-live', toAgentId: 'worker-two', title: '서류 전달', timestamp: '2026-01-01T10:05:00.000Z' }));
  await ui.advance(3_000);
  assert.equal(focusCalls(), focusBefore, 'a live handoff does not pull the camera out of a zoomed view');
  assert.equal(ui.get('game').dataset.zoomLock, 'true');
  ui.window.dispatchEvent(new ui.window.Event('blur')); await ui.flush();
  assert.equal(ui.get('game').dataset.cameraScope, 'floor', 'leaving the window keeps the zoomed floor');
  assert.equal(ui.scene.buildingView, false);
  ui.click('#zoom-out');
  assert.equal(ui.get('game').dataset.zoomLock, 'false', 'zooming back out releases the view');
  await ui.advance(26_000);
  assert.equal(ui.get('session-select').value, session, 'zoom-out does not restart observation');
  ui.key('c');
  await ui.advance(26_000);
  assert.notEqual(ui.get('session-select').value, session, 'explicit observation resumes room rotation');
  ui.scene.select('worker-live');
  ui.click('#zoom-in');
  assert.equal(ui.get('game').dataset.zoomLock, 'true');
  ui.click('#close-employee');
  assert.equal(ui.get('game').dataset.zoomLock, 'false', 'closing the employee card ends its close-up lock');
  ui.click('#zoom-in');
  ui.click('[data-open="communications"]');
  ui.click('[data-replay]');
  assert.equal(ui.get('game').dataset.zoomLock, 'false', 'an explicit replay releases the zoomed view');
  assert.equal(ui.scene.buildingView, true);
  ui.click('#zoom-in');
  ui.click('#building-cctv');
  assert.equal(ui.get('game').dataset.zoomLock, 'false', 'an explicit CCTV choice releases the zoomed view');
  assert.equal(ui.get('game').dataset.cameraScope, 'building');
  assert.equal(ui.scene.buildingView, true);
  ui.click('#zoom-in');
  await ui.advance(40_000);
  assert.equal(ui.scene.buildingView, true, 'a zoomed building overview is not replaced by an office shot');
  assert.equal(ui.get('game').dataset.cameraScope, 'building');
});

test('inactive characters disappear on both views and resume without moving a manually selected floor', async t => {
  const quiet = ['idle', 'waiting', 'done'].map((status, index) => snapshot({
    id: `quiet-${index}`, agentId: `quiet-${index}`, status,
  }));
  const ui = await mountOffice(t, { states: [{ agents: quiet, events: [] }] });
  ui.click('[data-floor="project-live"]'); ui.click('#zoom-in');
  const zoom = ui.scene.zoomLevel, callStart = ui.calls.length;
  const shown = entries => entries.filter(agent => agent.id !== 'boss' && agent.showCharacter !== false).map(agent => agent.id);
  assert.deepEqual(shown(ui.scene.agents), []);
  assert.deepEqual(shown(ui.scene.buildingFloors[0].agents), []);
  assert.equal(ui.get('room-activity').textContent, '3명 대기', 'decision 35: a zero count is left out');
  assert.equal(ui.get('staff-count').textContent, '3', 'source records remain available');
  for (const status of ['working', 'thinking', 'reviewing', 'approval', 'error', 'idle']) {
    await ui.emit(snapshot({ id: `next-${status}`, agentId: 'quiet-0', status }));
    const expected = status === 'idle' ? [] : ['quiet-0'];
    assert.deepEqual(shown(ui.scene.agents), expected);
    assert.deepEqual(shown(ui.scene.buildingFloors[0].agents), expected);
    if (status === 'approval' || status === 'error') {
      assert.equal(ui.get('room-activity').textContent, '1명 확인 필요 · 2명 대기');
    }
  }
  await ui.setHidden(true); await ui.setHidden(false);
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  assert.equal(ui.get('session-select').value, 'session-live');
  assert.equal(ui.scene.zoomLevel, zoom);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.calls.slice(callStart).some(call => ['focus', 'resetCamera'].includes(call[0])), false);
  ui.click('[data-open="team"]');
  ui.click('[data-roster-filter="all"]');
  assert.equal(ui.get('roster').querySelectorAll('[data-agent]').length, 3);
});

test('new Claude sessions appear immediately in their project without moving a selected camera', async t => {
  const ui = await mountOffice(t);
  ui.click('[data-floor="project-live"]');
  const previousCalls = ui.calls.length;
  await ui.emit(snapshot({ id: 'new-claude-room', source: 'claude', agentId: 'claude-new',
    observation: 'claude-log', sessionId: 'claude-new-chat', sessionName: '새 Claude 사무실' }));
  assert.equal(ui.get('session-select').options.length, 3);
  assert.match(ui.get('room-count').textContent, /2개 사무실/u);
  assert.equal(ui.get('session-select').value, 'session-live');
  assert.equal(ui.calls.slice(previousCalls).some(call => call[0] === 'resetCamera'), false);
  await ui.emit(snapshot({ id: 'new-claude-floor', source: 'claude', agentId: 'claude-other',
    projectId: 'claude-project', projectName: '새 Claude 프로젝트', sessionId: 'claude-other-chat' }));
  assert.ok(ui.document.querySelector('[data-floor="claude-project"]'));
});

test('a floor initially includes every chat and exposes working Astra before quiet Claude models', async t => {
  const workers = [
    snapshot({ id: 'claude-one', source: 'claude', agentId: 'claude-one', status: 'idle',
      sessionId: 'claude-one-chat', sessionName: '문서 채팅', model: 'claude-opus-5' }),
    snapshot({ model: 'gpt-6-astra', sessionName: '개발 채팅' }),
    snapshot({ id: 'claude-two', source: 'claude', agentId: 'claude-two', status: 'idle',
      sessionId: 'claude-two-chat', sessionName: '다른 Claude 채팅', model: 'claude-sonnet-5' }),
    snapshot({ id: 'claude-three', source: 'claude', agentId: 'claude-three', status: 'idle',
      sessionId: 'claude-two-chat', sessionName: '다른 Claude 채팅', model: 'claude-fable-5-1' }),
    initialSnapshots()[1],
  ];
  const ui = await mountOffice(t, { states: [{ agents: workers, events: [] }] });
  const all = '__all_sessions__';
  const floorIds = ['boss', 'worker-live'];
  assert.equal(ui.get('session-select').value, all, 'initial hydration chooses the whole floor');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), floorIds);
  assert.match(ui.get('model-signal').querySelector('button').textContent, /gpt-6-astra/u);
  assert.equal(ui.get('model-signal').querySelectorAll('button').length, 1, 'the footer only shows working models');
  ui.click('[data-floor="project-live"]');
  assert.equal(ui.get('session-select').value, all);
  assert.equal(ui.get('room-activity').textContent, '1명 작업 중 · 3명 대기');
  assert.equal(ui.get('room-count').textContent, '3개 사무실');
  assert.match(ui.get('watch-caption').textContent, /모든 채팅/u);
  assert.equal(ui.get('location-detail').textContent, '모든 채팅 · 1명 작업 중 · 3명 대기');
  assert.match(ui.get('session-select').querySelector('[value="session-live"]').textContent, /Codex.*개발 채팅/u);
  assert.match(ui.get('session-select').querySelector('[value="claude-one-chat"]').textContent, /Claude.*문서 채팅/u);

  ui.selectSession('claude-one-chat');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss']);
  assert.equal(ui.get('room-activity').textContent, '1명 대기');
  assert.match(ui.get('location-detail').textContent, /문서 채팅 · 1명 대기/u);
  ui.selectSession(all);
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), floorIds);
  ui.scene.select('worker-live');
  assert.equal(ui.get('session-select').value, all, 'focusing a coworker does not narrow the whole-floor view');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), floorIds);
  assert.deepEqual(ui.calls.at(-1), ['focus', 'worker-live']);
  ui.scene.select('worker-idle');
  assert.equal(ui.get('session-select').value, 'session-idle', 'selecting another floor still opens the employee location');
  ui.click('[data-floor="project-live"]');
  assert.equal(ui.get('session-select').value, all, 'returning to the floor restores its default whole-floor view');
});

test('whole-floor arrivals stay visible while an explicit chat filter and manual camera survive later activity', async t => {
  const claude = snapshot({ id: 'quiet-claude', source: 'claude', agentId: 'quiet-claude', status: 'idle',
    sessionId: 'claude-chat', sessionName: 'Claude 채팅', model: 'claude-opus-5' });
  const astra = snapshot({ model: 'gpt-6-astra' });
  const newcomer = snapshot({ id: 'new-chat', source: 'claude', agentId: 'new-claude',
    sessionId: 'new-claude-chat', model: 'claude-sonnet-5' });
  const laterAstra = snapshot({ id: 'later-astra', agentId: 'later-astra', sessionId: 'later-codex-chat', model: 'gpt-6-astra' });
  const ui = await mountOffice(t, { states: [
    { agents: [claude, astra], events: [] },
    { agents: [claude, astra, newcomer, laterAstra], events: [] },
  ] });
  ui.click('[data-floor="project-live"]');
  ui.click('#zoom-in');
  const allCameraStart = ui.calls.length, zoom = ui.scene.zoomLevel;
  await ui.emit(newcomer);
  assert.equal(ui.get('session-select').value, '__all_sessions__');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss', 'worker-live', 'new-claude']);
  assert.equal(ui.get('room-activity').textContent, '2명 작업 중 · 1명 대기');
  ui.window.dispatchEvent(new ui.window.Event('blur'));
  await ui.setHidden(true); await ui.setHidden(false);
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  await ui.advance(90_000);
  assert.equal(ui.scene.zoomLevel, zoom);
  assert.equal(ui.calls.slice(allCameraStart).some(call => ['focus', 'resetCamera'].includes(call[0])), false);

  ui.selectSession('claude-chat');
  ui.click('#zoom-in');
  const filteredCameraStart = ui.calls.length;
  await ui.emit({ ...laterAstra, timestamp: new Date(Date.now()).toISOString() });
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  await ui.setHidden(true); await ui.setHidden(false);
  ui.source.disconnect(); ui.source.open(); await ui.flush();
  await ui.advance(90_000);
  assert.equal(ui.get('session-select').value, 'claude-chat');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss']);
  assert.equal(ui.get('room-activity').textContent, '1명 대기');
  assert.equal(ui.scene.zoomLevel, zoom);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.calls.slice(filteredCameraStart).some(call => ['focus', 'resetCamera'].includes(call[0])), false);
});

test('usage refreshes on focus without changing manual observation, and bubbles remain optional', async t => {
  const ui = await mountOffice(t);
  const count = () => ui.requests.filter(path => path === '/api/usage').length;
  assert.equal(count(), 1);
  await ui.advance(4999); assert.equal(count(), 1);
  await ui.advance(1); assert.equal(count(), 2);
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush(); assert.equal(count(), 3);
  ui.click('[data-open="settings"]');
  for (const id of ['setting-bubbles']) {
    ui.get(id).checked = false; ui.get(id).dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  }
  assert.equal(ui.scene.bubbles, false);
  assert.equal(ui.scene.labels, true);
  assert.equal(ui.get('setting-awayCctv'), null);
  ui.click('#close-panel'); ui.click('[data-floor="project-live"]');
  ui.window.dispatchEvent(new ui.window.Event('blur')); await ui.flush();
  assert.equal(ui.get('game').dataset.cameraScope, 'floor');
});

test('a hidden initial window loads usage once and refreshes immediately when visible without background polling', async t => {
  const ui = await mountOffice(t, { initiallyHidden: true });
  const count = () => ui.requests.filter(path => path === '/api/usage').length;
  assert.equal(count(), 1, 'initial usage must not depend on an animation frame or focus event');
  await ui.advance(12000);
  assert.equal(count(), 1, 'hidden windows do not keep polling');
  await ui.setHidden(false);
  assert.equal(count(), 2, 'visibility alone refreshes a window shown on another monitor');
});

test('the first SSE connection retries a failed initial snapshot and restores connected staff', async t => {
  const ui = await mountOffice(t, { autoConnect: false, stateError: true });
  assert.equal(ui.stateRequests, 1);
  assert.equal(ui.get('staff-count').textContent, '0');
  assert.equal(ui.scene.paused, true);
  ui.source.open(); await ui.flush();
  assert.equal(ui.stateRequests, 2, 'the first connection retries when no snapshot was available');
  assert.equal(ui.get('staff-count').textContent, '2');
  assert.equal(ui.get('connection-notice').hidden, true);
  assert.equal(ui.scene.paused, false);
  assert.deepEqual([...ui.document.querySelectorAll('[data-floor]')].map(button => button.dataset.floor), ['project-live', 'project-idle']);
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss', 'worker-live']);
});

test('a large connected room reaches the scene together and camera follows observed work after a manual hold', async t => {
  const workers = Array.from({ length: 30 }, (_, i) => snapshot({ id: `large-${i}`, agentId: `worker-${i}`, status: i < 2 ? 'working' : 'idle' }));
  const ui = await mountOffice(t, { states: [{ agents: workers, events: [] }] });
  assert.equal(ui.scene.agents.length, 3, 'only the two active employees and the boss occupy the room');
  assert.equal(ui.get('staff-count').textContent, '30', 'all records remain available');
  assert.equal(ui.get('room-pager'), null, 'there is no five-employee page switch');
  assert.equal(ui.scene.buildingView,true,'even one connected project begins with a building overview');
  ui.click('[data-floor="project-live"]');
  ui.key('c');
  await ui.advance(6000);
  const first = ui.calls.filter(call => call[0] === 'focus').at(-1);
  assert.deepEqual(first, ['focus', 'worker-0', { cinematic: true, zoom: 1.5 }]);
  ui.get('scene').dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true }));
  const count = ui.calls.filter(call => call[0] === 'focus').length;
  await ui.advance(17_000);
  assert.equal(ui.calls.filter(call => call[0] === 'focus').length, count);
  await ui.advance(1000);
  assert.equal(ui.calls.filter(call => call[0] === 'focus').at(-1)[1], 'worker-1');
  await ui.emit(snapshot({ id: 'visit-boss', type: 'approval.requested', agentId: 'worker-1' }));
  assert.ok(ui.calls.some(call => call[0] === 'requestApproval' && call[1] === 'worker-1'));
  await ui.emit(snapshot({ id: 'leave-boss', type: 'approval.resolved', agentId: 'worker-1' }));
  assert.ok(ui.calls.some(call => call[0] === 'resolveApproval' && call[1] === 'worker-1'));
  ui.click('[data-open="settings"]');
  ui.get('setting-followWork').checked = false;
  ui.get('setting-followWork').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  assert.deepEqual(ui.calls.at(-1), ['stopFollowing']);
  ui.click('#close-panel');
  const afterStop = ui.calls.filter(call => call[0] === 'focus').length;
  await ui.advance(60_000);
  assert.equal(ui.calls.filter(call => call[0] === 'focus').length, afterStop);
});

test('shared energy stays visible in CCTV, separates Spark, and keeps the last value dimmed when quota connection is lost', async t => {
  const ui = await mountOffice(t, { usageFailsAfter: 1, usage: { providers: [{ provider: 'codex', status: 'live',
    updatedAt: timestamp, source: 'codex-app-server', windows: [
      { id: 'codex:primary', label: 'Codex 주간', usedPercent: 3, windowMinutes: 10080, resetsAt: Date.parse(timestamp) / 1000 + 86400 },
      { id: 'codex_bengalfox:primary', label: 'Spark 5시간', usedPercent: 100, windowMinutes: 300, resetsAt: Date.parse(timestamp) / 1000 + 3600 },
    ] }] } });
  assert.match(ui.get('energy-tanks').querySelector('.codex').textContent, /97%/);
  assert.match(ui.get('energy-tanks').querySelector('.claude').textContent, /—.*상태줄 연결 대기/);
  ui.key('c');
  assert.equal(ui.get('energy-hud').closest('.hud'), null, 'energy is outside HUD that CCTV hides');
  ui.click('.energy-tank.codex');
  assert.equal(ui.get('office-panel').open, true);
  assert.match(ui.get('usage-detail').textContent, /Codex 주간.*97%.*사용 3%/);
  assert.match(ui.get('usage-detail').textContent, /Spark 5시간.*0%.*사용 100%/);
  await ui.advance(30_000);
  assert.match(ui.get('energy-tanks').querySelector('.codex').textContent, /97%.*수신기 연결 확인 필요 · .*기준/, 'aged value stays visible with its observation time');
  assert.ok(ui.get('energy-tanks').querySelector('.codex').classList.contains('aged'), 'aged tank is dimmed, not presented as current');
  assert.match(ui.get('energy-tanks').querySelector('.codex').getAttribute('aria-label'), /최신 아님/);
  assert.match(ui.get('usage-detail').textContent, /마지막 기록.*97%/);
  assert.match(ui.get('usage-detail').textContent, /마지막 보고:.*회복/);
});

test('late model evidence updates the badge without changing work or producing a new employee', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot({ source: 'claude', model: undefined, modelEvidence: 'unknown' })], events: [] }] });
  const original = structuredClone(ui.scene.agents.find(a => a.id === 'worker-live'));
  const dispatch = ui.get('dispatch-text').textContent;
  const patch = snapshot({ id: 'model-evidence', type: 'agent.model', observation: 'claude-log', source: 'claude',
    referenceEventId: 'snapshot-working', model: 'reported-model', modelEvidence: 'reported', modelObservedAt: timestamp,
    timestamp: '2026-01-01T10:01:00.000Z', title: '실행 모델 확인' });
  await ui.emit(patch);
  const updated = ui.scene.agents.find(a => a.id === 'worker-live');
  assert.equal(updated.model, 'reported-model');
  assert.equal(updated.task, original.task);
  assert.equal(updated.status, original.status);
  assert.equal(updated.lastEventAt, original.lastEventAt);
  assert.equal(ui.get('dispatch-text').textContent, dispatch);
  await ui.emit({ ...patch, id: 'wrong-reference', referenceEventId: 'old-event', model: 'wrong-model' });
  assert.equal(ui.scene.agents.find(a => a.id === 'worker-live').model, 'reported-model');
  await ui.emit({ ...patch, id: 'nonexistent-model', agentId: 'never-connected' });
  assert.equal(ui.scene.agents.some(a => a.id === 'never-connected'), false);
});

test('local company and owner settings survive incoming work, saving, and a state reload', async t => {
  const ui = await mountOffice(t);
  assert.equal(ui.scene.agents.find(agent => agent.id === 'boss').name, '예시 사장');
  ui.click('[data-open="settings"]');
  assert.equal(ui.get('company-name').value, '테스트 사무실');
  assert.equal(ui.get('owner-name').value, '예시 사장');
  const draftName = '<b>새 사장</b>';
  ui.get('owner-name').value = draftName;
  ui.get('owner-name').dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.get('company-name').value = '새로운 사무실';
  await ui.emit(snapshot({ id: 'work-while-editing', title: '다음 업무' }));
  assert.equal(ui.get('owner-name').value, draftName, 'SSE rendering must preserve a settings draft');
  assert.equal(ui.scene.agents.find(agent => agent.id === 'boss').name, '예시 사장', 'drafts do not rename the boss');
  ui.get('company-form').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await ui.flush();
  assert.deepEqual(ui.settingsWrites, [{ companyName: '새로운 사무실', ownerName: draftName }]);
  assert.equal(ui.scene.agents.find(agent => agent.id === 'boss').name, draftName);
  assert.equal(ui.document.querySelector('[data-company-name]').textContent, '새로운 사무실');
  assert.equal(ui.document.querySelector('[data-owner-name]').textContent, draftName);
  assert.equal(ui.document.querySelector('[data-owner-name] b'), null, 'names are text, never HTML');
  assert.match(ui.get('company-save-status').textContent, /반영했어요/);
  ui.click('#close-panel');
  ui.source.disconnect(); ui.source.open(); await ui.flush();
  assert.equal(ui.scene.agents.find(agent => agent.id === 'boss').name, draftName);
  assert.equal(ui.document.title, '새로운 사무실 · Cubirumi');
});

test('failed settings writes preserve the displayed names and keep the draft available to retry', async t => {
  const ui = await mountOffice(t, { settingsSaveError: true });
  ui.click('[data-open="settings"]');
  ui.get('owner-name').value = '변경할 이름';
  ui.get('owner-name').dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.get('company-form').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await ui.flush();
  assert.equal(ui.scene.agents.find(agent => agent.id === 'boss').name, '예시 사장');
  assert.match(ui.get('company-save-status').textContent, /저장하지 못/);
  assert.equal(ui.get('save-company').disabled, false);
  ui.click('#close-panel'); ui.click('[data-open="settings"]');
  assert.equal(ui.get('owner-name').value, '변경할 이름');
});

test('live handoffs fly between computers while instructions to a scene without owner planes are recorded only', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot(), snapshot({ id: 'recipient', agentId: 'worker-to' })], events: [] }] });
  ui.click('[data-floor="project-live"]');
  const handoff = snapshot({ id: 'real-handoff', type: 'handoff', toAgentId: 'worker-to', title: '검토 결과 공유' });
  await ui.emit(handoff); await ui.emit(handoff); await ui.advance(2000);
  assert.deepEqual(ui.calls.filter(call => call[0] === 'sendPaperPlane'), [['sendPaperPlane', 'worker-live', 'worker-to', 'real-handoff']]);
  assert.equal(ui.calls.filter(call => call[0] === 'deliver').length, 0);
  await ui.emit(snapshot({ id: 'instruction', type: 'user.instruction', toAgentId: 'worker-live', title: '업무 지시' }));
  await ui.advance(4000);
  assert.deepEqual(ui.calls.filter(call => call[0] === 'sendMessagePlane'), [], 'decision 50: no local message flight stands in for the owner plane');
  assert.equal(ui.calls.filter(call => call[0] === 'deliver').length, 0, 'an instruction does not also start a walking delivery');
  assert.equal(ui.get('staff-count').textContent, '2');
  ui.click('[data-open="communications"]');
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length, 2, 'the instruction stays in the communication history');
});

test('general messages stay at their visible computer without changing camera, status, or inventing recipients', async t => {
  const ui=await mountOffice(t,{savedSettings:{cycle:false,followWork:false}});
  ui.click('[data-floor="project-live"]');
  const start=ui.calls.length;
  const message=snapshot({id:'local-message',type:'message.sent',title:'실제 응답 메시지 송신',status:'idle'});
  await ui.emit(message); await ui.emit(message);
  assert.deepEqual(ui.calls.slice(start),[['sendMessagePlane','worker-live','local-message']]);
  assert.equal(ui.scene.buildingView,false);
  assert.equal(ui.get('room-title').textContent,'실제 프로젝트');
  assert.equal(ui.scene.agents.find(agent=>agent.id==='worker-live').status,'working','message metadata is not a lifecycle transition');
  ui.click('[data-open="communications"]');
  const items=ui.get('feed').querySelectorAll('.feed-event');
  assert.equal(items.length,1);
  assert.match(items[0].textContent,/메시지 송신/u);
  assert.equal(items[0].querySelector('.event-route').textContent,'연결된 직원','a general message has no fabricated recipient arrow');
  assert.ok(items[0].querySelector('[data-replay="local-message"]'));
});

test('local messages wait for visible staff and respect pause, hidden state, cooldown and 30-second expiry', async t => {
  const ui=await mountOffice(t,{savedSettings:{cycle:false,followWork:false}});
  const flights=()=>ui.calls.filter(call=>call[0]==='sendMessagePlane');
  const message=(id,agentId='worker-idle')=>snapshot({id,type:'message.sent',agentId,timestamp:new Date(Date.now()).toISOString()});
  ui.click('[data-floor="project-live"]');
  await ui.emit(message('offscreen'));await ui.advance(3000);
  assert.equal(flights().length,0);assert.equal(ui.scene.buildingView,false);
  ui.click('[data-floor="project-idle"]');await ui.advance(1000);
  assert.deepEqual(flights(),[['sendMessagePlane','worker-idle','offscreen']]);
  await ui.emit(message('cooldown'));assert.equal(flights().length,1);
  await ui.advance(3000);assert.equal(flights().length,2);
  ui.click('#pause');await ui.emit(message('paused'));await ui.advance(3000);
  assert.equal(flights().length,2);
  ui.click('#pause');await ui.advance(1000);assert.equal(flights().at(-1)[2],'paused');
  await ui.setHidden(true);await ui.emit(message('hidden'));await ui.advance(3000);
  assert.equal(flights().length,3);
  await ui.setHidden(false);await ui.advance(1000);assert.equal(flights().at(-1)[2],'hidden');
  ui.click('[data-floor="project-live"]');await ui.emit(message('expired'));await ui.advance(31_000);
  ui.click('[data-floor="project-idle"]');await ui.advance(1000);
  assert.equal(flights().length,4);
  ui.click('[data-open="communications"]');
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length,5,'throttled and expired animation events remain in the communication history');
});

test('historical instructions offer no replay, sent messages require explicit replay and reduced motion suppresses their flights', async t => {
  const past=[snapshot({id:'past-sent',type:'message.sent',timestamp:'2026-01-01T09:55:00.000Z'}),
    snapshot({id:'past-instruction',type:'user.instruction',toAgentId:'worker-idle',timestamp:'2026-01-01T09:54:00.000Z'})];
  const ui=await mountOffice(t,{states:[{agents:initialSnapshots(),events:past}],savedSettings:{cycle:false,followWork:false}});
  const flights=()=>ui.calls.filter(call=>call[0]==='sendMessagePlane');
  await ui.advance(3000);assert.equal(flights().length,0);
  ui.click('[data-open="communications"]');
  assert.deepEqual([...ui.get('feed').querySelectorAll('[data-replay]')].map(button=>button.dataset.replay),['past-sent'],
    'decision 50: an instruction would replay as a flightless building view, so only the message offers a replay');
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length,2,'the instruction stays in the history');
  ui.click('[data-replay="past-sent"]');await ui.advance(3000);
  assert.equal(flights().length,1);
  assert.equal(flights().at(-1)[1],'worker-live');
  assert.match(flights().at(-1)[2],/^past-sent:replay:/u);
  ui.click('[data-open="settings"]');
  ui.get('setting-reducedMotion').checked=true;
  ui.get('setting-reducedMotion').dispatchEvent(new ui.window.Event('change',{bubbles:true}));
  await ui.emit(snapshot({id:'reduced-message',type:'message.sent',timestamp:new Date(Date.now()).toISOString()}));
  await ui.advance(4000);assert.equal(flights().length,1);
  ui.click('[data-open="communications"]');
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length,3);
  assert.equal(ui.requests.some(path=>path==='/api/events'),false,'replaying history never sends a provider message');
});

test('building CCTV receives every connected project and room, and actual floor selection can return outside', async t => {
  const workers = [snapshot(), snapshot({ id:'same-project', agentId:'same-project-worker', sessionId:'another-chat', agentName:'다른 채팅 직원' }),
    snapshot({ id:'other-project', agentId:'other-worker', projectId:'project-other', projectName:'다른 프로젝트', sessionId:'other-chat' }),
    initialSnapshots()[1], initialSnapshots()[2], initialSnapshots()[3],
    snapshot({ id:'ended', agentId:'ended-worker', projectId:'ended-project', sessionId:'ended-session', type:'session.ended', sessionEnded:true })];
  const ui = await mountOffice(t, { states:[{ agents:workers, events:[] }] });
  assert.equal(ui.scene.buildingView, true, 'the first shot shows the whole connected building');
  assert.equal(ui.get('location-project').textContent,'테스트 사무실');
  assert.equal(ui.get('location-floor').textContent,'3개 층');
  assert.deepEqual(ui.scene.buildingFloors.map(floor=>floor.id), ['project-live','project-other','project-idle']);
  assert.deepEqual(ui.scene.buildingFloors.flatMap(floor=>floor.agents.map(agent=>agent.id)).sort(),
    ['worker-live','same-project-worker','other-worker'].sort());
  assert.equal(ui.scene.buildingFloors.find(floor=>floor.id==='project-live').agents.length,2,'different conversations in a project share its miniature floor');
  assert.deepEqual(ui.scene.buildingFloors.map(floor=>floor.name), ['실제 프로젝트','다른 프로젝트','대기 프로젝트']);
  assert.equal(typeof ui.scene.selectFloor,'function','the real constructor wires clickable building labels');
  ui.scene.selectFloor('project-other'); await ui.flush();
  assert.equal(ui.scene.buildingView,false);
  assert.equal(ui.get('game').dataset.cameraScope,'floor');
  assert.equal(ui.get('room-title').textContent,'다른 프로젝트');
  assert.equal(ui.get('location-project').textContent,'다른 프로젝트');
  assert.equal(ui.get('location-mode').textContent,'선택한 층');
  assert.deepEqual(ui.scene.agents.map(agent=>agent.id),['boss','other-worker']);
  ui.window.dispatchEvent(new ui.window.Event('blur')); await ui.flush();
  assert.equal(ui.scene.buildingView,false, 'leaving the window keeps the selected floor');
  assert.equal(ui.get('game').dataset.cameraScope,'floor');
  ui.click('#building-cctv');
  assert.equal(ui.scene.buildingView,true);
  assert.equal(ui.get('game').dataset.cameraScope,'building');
  assert.equal(ui.scene.buildingProject,'','returning outside restores the whole building, not only the previously selected floor');
});

test('live messages wait across hidden windows and rooms, then use real building endpoints without phantom staff', async t => {
  const workers = [snapshot(), snapshot({ id:'recipient', agentId:'worker-to', sessionId:'another-room' }),
    snapshot({ id:'third', agentId:'worker-third', projectId:'third-project', projectName:'세 번째 프로젝트', sessionId:'third-room' })];
  const ui = await mountOffice(t, { states:[{ agents:workers, events:[] }] });
  const flights = () => ui.calls.filter(call=>call[0]==='sendPaperPlane'||call[0]==='sendBuildingPaperPlane');
  ui.click('#building-cctv');
  await ui.setHidden(true);
  const hidden = snapshot({id:'hidden-message',type:'handoff',toAgentId:'worker-to',title:'에이전트에게 메시지 전달 요청'});
  await ui.emit(hidden); await ui.advance(1000); assert.equal(flights().length,0);
  await ui.setHidden(false); await ui.advance(2000);
  assert.deepEqual(flights(),[['sendBuildingPaperPlane','worker-live','worker-to','hidden-message']]);
  await ui.emit(hidden); assert.equal(flights().length,1,'SSE duplicates never fly twice');
  ui.click('[data-floor="project-live"]');
  ui.selectSession('session-live');
  const crossRoom = snapshot({id:'other-room-message',type:'handoff',toAgentId:'worker-to',timestamp:new Date(Date.now()).toISOString()});
  await ui.emit(crossRoom); assert.equal(flights().length,1,'another chat is not a visible indoor endpoint');
  ui.click('#building-cctv'); await ui.advance(3000);
  assert.deepEqual(flights().at(-1),['sendBuildingPaperPlane','worker-live','worker-to','other-room-message']);
  await ui.emit(snapshot({id:'other-floor-message',type:'handoff',toAgentId:'worker-third',timestamp:new Date(Date.now()).toISOString()}));
  await ui.advance(2000);
  assert.deepEqual(flights().at(-1),['sendBuildingPaperPlane','worker-live','worker-third','other-floor-message']);
  const count=flights().length;
  await ui.emit(snapshot({id:'unknown-recipient',type:'handoff',toAgentId:'never-connected',timestamp:new Date(Date.now()).toISOString()}));
  assert.equal(flights().length,count); assert.equal(ui.get('staff-count').textContent,'3');
  await ui.setHidden(true);
  await ui.emit(snapshot({id:'expired-hidden',type:'handoff',toAgentId:'worker-to',timestamp:new Date(Date.now()).toISOString()}));
  await ui.advance(31_000); await ui.setHidden(false); await ui.advance(1000);
  assert.equal(flights().length,count,'old hidden messages expire instead of appearing as new activity');
});

test('historical communication only flies after explicit replay and keeps the replay label separate from live records', async t => {
  const past=snapshot({id:'past-handoff',type:'handoff',toAgentId:'worker-to',timestamp:'2026-01-01T09:55:00.000Z',title:'에이전트에게 메시지 전달 요청'});
  const ui=await mountOffice(t,{states:[{agents:[snapshot(),snapshot({id:'recipient',agentId:'worker-to'})],events:[past]}]});
  const flights=()=>ui.calls.filter(call=>call[0]==='sendPaperPlane'||call[0]==='sendBuildingPaperPlane');
  await ui.advance(3000);assert.equal(flights().length,0,'hydrated history is not presented as a new handoff');
  ui.click('[data-open="communications"]');
  ui.click('[data-replay="past-handoff"]');await ui.advance(3000);
  assert.equal(ui.get('office-panel').open,false);
  assert.equal(ui.get('location-mode').textContent,'기록 다시 보기');
  assert.match(ui.get('toast').textContent,/새로운 메시지를 보내지는 않아요/u);
  assert.equal(flights().length,1);assert.equal(flights()[0][0],'sendBuildingPaperPlane');
  assert.match(flights()[0][3],/^past-handoff:replay:/u);
  assert.equal(ui.requests.some(path=>path==='/api/events'),false,'replay never posts a fabricated provider event');
  ui.click('[data-open="communications"]');
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length,1,'replay does not add another communication to the history');
  ui.click('#close-panel');await ui.advance(16_000);
  assert.doesNotMatch(ui.get('location-mode').textContent,/기록 다시 보기/u);
});

test('a continuing stream of real messages cannot postpone all queued flights until traffic stops', async t => {
  const ui=await mountOffice(t,{states:[{agents:[snapshot(),snapshot({id:'recipient',agentId:'worker-to'})],events:[]}]});
  await ui.advance(3000);
  for(let index=0;index<15;index++){
    await ui.emit(snapshot({id:`burst-${index}`,type:'handoff',toAgentId:'worker-to',timestamp:new Date(Date.now()).toISOString()}));
    await ui.advance(1000);
  }
  assert.ok(ui.calls.some(call=>call[0]==='sendPaperPlane'||call[0]==='sendBuildingPaperPlane'),
    'camera settling applies to a shot, not an endlessly renewed delay for every message');
});

test('explicit observation after a manual quiet floor uses activity across the whole building', async t => {
  const ui = await mountOffice(t);
  ui.click('[data-floor="project-idle"]'); ui.click('#zoom-in');
  ui.window.dispatchEvent(new ui.window.Event('focus')); await ui.flush();
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  ui.key('c'); await ui.advance(1000);
  assert.equal(ui.get('game').dataset.cameraScope, 'building');
  assert.equal(ui.get('room-title').textContent, '실제 프로젝트');
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'true');
});

test('observation releases its final departed worker once and then waits for activity', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot()], events: [] }] });
  ui.key('c'); await ui.advance(20_000);
  assert.match(ui.get('director-caption').textContent, /따라보는 중/);
  const before = ui.calls.length;
  await ui.emit(snapshot({ id: 'final-end', status: 'idle', timestamp: new Date(Date.now()).toISOString() }));
  await ui.advance(1000);
  assert.equal(ui.get('director-caption').textContent, '');
  assert.deepEqual(ui.calls.slice(before).filter(call => call[0] === 'focus'), [['focus', null, { cinematic: true, zoom: 1 }]]);
  const quiet = ui.calls.length;
  await ui.advance(30_000);
  assert.equal(ui.calls.slice(quiet).some(call => call[0] === 'focus'), false);
});

test('one active floor can frame a real handoff across chats without creating activity for its idle recipient', async t => {
  const recipient = snapshot({ id: 'recipient', agentId: 'worker-to', sessionId: 'other-chat', status: 'idle' });
  const ui = await mountOffice(t, { states: [{ agents: [snapshot(), recipient], events: [] }] });
  ui.click('[data-floor="project-live"]'); ui.selectSession('session-live'); ui.key('c'); await ui.advance(6000);
  await ui.emit(snapshot({ id: 'single-floor-handoff', type: 'handoff', toAgentId: 'worker-to', timestamp: new Date(Date.now()).toISOString() }));
  await ui.advance(3000);
  assert.ok(ui.calls.some(call => call[0] === 'sendPaperPlane' && call[3] === 'single-floor-handoff'));
  assert.equal(ui.scene.agents.find(agent => agent.id === 'worker-to').showCharacter, false);
  assert.equal(ui.get('active-count').textContent, '1');
});

test('quoted project and chat names do not replace identical navigation DOM on each tick', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot({ projectName: '팀 "사무실"', sessionName: "오늘의 '계획'" })], events: [] }] });
  const floor = ui.document.querySelector('[data-floor]');
  const session = ui.get('session-select').firstElementChild;
  await ui.advance(3000);
  assert.equal(ui.document.querySelector('[data-floor]') === floor, true);
  assert.equal(ui.get('session-select').firstElementChild === session, true);
});

test('new communication preserves keyboard focus on an existing replay button', async t => {
  const past = snapshot({ id: 'past-replay', type: 'message.sent', timestamp: '2026-01-01T09:59:00.000Z' });
  const ui = await mountOffice(t, { states: [{ agents: [snapshot()], events: [past] }] });
  ui.click('[data-open="communications"]');
  ui.document.querySelector('[data-replay="past-replay"]').focus();
  await ui.emit(snapshot({ id: 'next-message', type: 'message.sent', timestamp: new Date(Date.now()).toISOString() }));
  assert.equal(ui.document.activeElement.dataset.replay, 'past-replay');
});

test('the communication history offers replay for handoffs and messages but not for instructions', async t => {
  const past = [
    snapshot({ id: 'past-handoff-kept', type: 'handoff', toAgentId: 'worker-idle', timestamp: '2026-01-01T09:57:00.000Z' }),
    snapshot({ id: 'past-order', type: 'user.instruction', toAgentId: 'worker-idle', timestamp: '2026-01-01T09:58:00.000Z' }),
    snapshot({ id: 'past-message-kept', type: 'message.sent', timestamp: '2026-01-01T09:59:00.000Z' }),
  ];
  const ui = await mountOffice(t, { states: [{ agents: initialSnapshots(), events: past }], savedSettings: { cycle: false, followWork: false } });
  ui.click('[data-open="communications"]');
  const items = [...ui.get('feed').querySelectorAll('.feed-event')];
  assert.equal(items.length, 3);
  const order = items.find(item => /업무 지시/u.test(item.textContent));
  assert.ok(order, 'the instruction is listed');
  assert.equal(order.querySelector('.handoff-replay'), null, 'decision 50: an instruction replay would only open the building view, so it has no button');
  assert.deepEqual([...ui.get('feed').querySelectorAll('[data-replay]')].map(button => button.dataset.replay).sort(), ['past-handoff-kept', 'past-message-kept']);
  ui.document.querySelector('[data-replay="past-message-kept"]').focus();
  await ui.emit(snapshot({ id: 'live-order', type: 'user.instruction', toAgentId: 'worker-idle', timestamp: new Date(Date.now()).toISOString() }));
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length, 4);
  assert.equal(ui.document.activeElement.dataset.replay, 'past-message-kept', 'a new instruction record keeps focus on a kept replay button');
  assert.equal(ui.get('feed').querySelectorAll('[data-replay]').length, 2);
});

test('ordinary display settings follow OS motion changes until an explicit override and can return to system defaults', async t => {
  const ui = await mountOffice(t);
  ui.click('[data-open="settings"]');
  ui.get('setting-labels').checked = false; ui.get('setting-labels').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  const saved = JSON.parse(ui.window.localStorage.getItem('agent-office.view.v1'));
  assert.equal(Object.hasOwn(saved, 'reducedMotion'), false, 'an inherited value is not stored as an explicit choice');
  await ui.setSystemReducedMotion(true);
  assert.equal(ui.scene.reducedMotion, true);
  ui.get('setting-reducedMotion').checked = false; ui.get('setting-reducedMotion').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await ui.setSystemReducedMotion(false); await ui.setSystemReducedMotion(true);
  assert.equal(ui.scene.reducedMotion, false, 'an explicit app choice survives an OS change');
  ui.click('#setting-systemMotion');
  assert.equal(ui.scene.reducedMotion, true);
  await ui.setSystemReducedMotion(false);
  assert.equal(ui.scene.reducedMotion, false);
});

test('approval notifications live inside the active modal and return to the fullscreen root when it closes', async t => {
  const ui = await mountOffice(t);
  ui.click('[data-open="settings"]');
  await ui.emit(snapshot({ id: 'panel-approval', type: 'approval.requested', status: 'approval' }));
  const toast = ui.get('toast');
  assert.equal(ui.get('office-panel').contains(toast), true, 'the alert must be in the active top layer, not its inert backdrop');
  assert.equal(toast.getAttribute('aria-live'), 'polite');
  assert.equal(toast.getAttribute('aria-atomic'), 'true');
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /확인 요청/);
  ui.click('#close-panel'); await ui.flush();
  assert.equal(toast.parentElement, ui.get('game'));
  assert.equal(ui.document.querySelectorAll('#toast').length, 1);
});

test('only current activity occupies desks while quiet staff remain available for inspection', async t => {
  const quiet = Array.from({ length: 100 }, (_, i) => snapshot({ id: `quiet-${i}`, agentId: `quiet-${i}`, status: 'idle' }));
  const ui = await mountOffice(t, { states: [{ agents: [snapshot(), ...quiet], events: [] }] });
  assert.deepEqual(ui.scene.agents.map(a => a.id), ['boss', 'worker-live']);
  assert.equal(ui.scene.buildingFloors[0].agents.length, 1);
  assert.equal(ui.get('staff-count').textContent, '101');
  await ui.emit(snapshot({ id: 'finished', type: 'agent.completed', timestamp: new Date(Date.now() + 1000).toISOString() }));
  assert.deepEqual(ui.scene.agents.map(a => a.id), ['boss']);
  assert.equal(ui.scene.buildingFloors.length, 1);
  assert.equal(ui.scene.buildingFloors[0].agents.length, 0);
  assert.equal(ui.get('active-count').textContent, '0');
  ui.click('[data-open="team"]'); ui.click('[data-roster-filter="all"]'); ui.click('[data-agent="quiet-50"]');
  assert.deepEqual(ui.scene.agents.map(a => a.id), ['boss', 'quiet-50']);
  assert.equal(ui.scene.agents[1].showCharacter, true);
  ui.click('#close-employee'); await ui.flush();
  assert.deepEqual(ui.scene.agents.map(a => a.id), ['boss']);
});

test('old working and error snapshots are unconfirmed rather than current activity, while their records remain inspectable', async t => {
  const old = '2026-01-01T09:54:59.000Z';
  const workers = [snapshot({ timestamp: old }), snapshot({ id: 'old-error', agentId: 'worker-error', agentName: '지난 오류 직원',
    status: 'error', timestamp: old, title: '도구 실행 오류' })];
  const ui = await mountOffice(t, { states: [{ agents: workers, events: [] }] });
  assert.equal(ui.get('active-count').textContent, '0');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss']);
  assert.equal(ui.scene.buildingFloors[0].agents.length, 0);
  assert.equal(ui.get('staff-count').textContent, '2', 'historical employee records are retained');
  assert.deepEqual(ui.scene.buildingFloors[0].counts, { working: 0, approval: 0, error: 0, quiet: 0, unconfirmed: 2 });
  ui.click('[data-open="team"]'); ui.click('[data-roster-filter="all"]');
  assert.equal(ui.get('roster').querySelectorAll('[data-agent]').length, 2);
  assert.match(ui.get('roster').textContent, /현재 상태 미확인/u);
  assert.equal(ui.get('roster').querySelectorAll('.employee-status .status-shape[data-shape="unknown"]').length, 2,
    'the roster draws the unconfirmed shape rather than quiet, work or error');
  ui.click('[data-agent="worker-error"]');
  const detail = ui.get('employee-detail');
  assert.equal(detail.querySelector('.card-section-title').textContent, '마지막으로 보인 일');
  // Decision 22: the last status uses the shared table wording.
  assert.match(detail.querySelector('.unconfirmed-banner').textContent, /마지막 상태: 오류(?! 발생)/u);
  assert.match(detail.textContent, /도구 실행 오류/u);
  assert.equal(detail.querySelector('.status-chip').textContent, '현재 상태 미확인');
  assert.equal(detail.querySelector('.status-chip .status-shape').getAttribute('data-shape'), 'unknown');
  assert.equal(detail.querySelector('.elapsed'), null);
  assert.equal(detail.querySelector('.tool-line'), null);
  assert.equal(detail.querySelector('.card-note'), null, 'an old error is not presented as a current alert');
  const selected = ui.scene.agents.find(agent => agent.id === 'worker-error');
  assert.equal(selected.status, 'idle', 'a selected historical employee has no active marker');
  assert.equal(selected.unconfirmedStatus, 'error', 'the original source status is preserved');
  assert.equal(selected.showCharacter, true, 'manual inspection can still reveal the employee');
  ui.scene.select('boss');
  const stats = [...detail.querySelectorAll('[data-boss-stat]')].map(button => button.dataset.bossStat);
  assert.deepEqual(stats, ['unconfirmed', 'floors'], 'the owner card counts neither work nor attention for old reports, and omits zero cells');
  const unconfirmedStat = detail.querySelector('[data-boss-stat="unconfirmed"]');
  assert.match(unconfirmedStat.textContent, /2명상태 미확인/u);
  assert.equal(unconfirmedStat.querySelector('.status-shape').getAttribute('data-shape'), 'unknown');
  ui.click('[data-boss-stat="unconfirmed"]');
  assert.equal(ui.get('office-panel').open, true);
  assert.equal(ui.document.querySelector('[data-roster-filter="all"]').getAttribute('aria-pressed'), 'true', 'the cell opens every employee');
});

test('five minutes without observations removes work from the scene and automatic tour, and new work restores it immediately', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot()], events: [] }] });
  ui.key('c');
  await ui.advance(299_999);
  assert.equal(ui.get('active-count').textContent, '1', 'a report remains current before the five-minute boundary');
  assert.ok(ui.scene.agents.some(agent => agent.id === 'worker-live' && agent.status === 'working'));
  await ui.advance(1);
  assert.equal(ui.get('active-count').textContent, '0', 'the one-second timer updates activity without another server event');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss']);
  assert.equal(ui.scene.buildingFloors[0].agents.length, 0);
  assert.match(ui.get('cycle-status').textContent, /작업 중인 직원을 기다리는 중/u);
  assert.equal(ui.scene.autoRotate, false);
  const callsAfterExpiry = ui.calls.length;
  await ui.advance(60_000);
  assert.equal(ui.calls.slice(callsAfterExpiry).some(call => ['focus', 'resetCamera'].includes(call[0])), false,
    'the automatic director cannot keep visiting an unconfirmed worker');
  await ui.emit(snapshot({ id: 'fresh-after-gap', title: '새 도구 실행', timestamp: new Date(Date.now()).toISOString() }));
  assert.equal(ui.get('active-count').textContent, '1');
  const active = ui.scene.agents.find(agent => agent.id === 'worker-live');
  assert.equal(active.status, 'working');
  assert.equal(active.unconfirmedStatus, undefined);
  await ui.advance(1000);
  assert.equal(ui.scene.autoRotate, true);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'true');
});

test('freshness expiration keeps a manually selected employee quiet without changing its floor, camera or historical work', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot({ taskStartedAt: timestamp, toolName: 'Edit', activityKind: 'coding' })], events: [] }] });
  ui.click('[data-floor="project-live"]');
  ui.scene.select('worker-live');
  ui.click('#zoom-in');
  const zoom = ui.scene.zoomLevel, callsBeforeExpiry = ui.calls.length;
  await ui.advance(300_000);
  assert.equal(ui.get('watch-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.get('room-title').textContent, '실제 프로젝트');
  assert.equal(ui.get('session-select').value, 'session-live');
  assert.equal(ui.scene.zoomLevel, zoom);
  assert.equal(ui.calls.slice(callsBeforeExpiry).some(call => ['focus', 'resetCamera'].includes(call[0])), false);
  const selected = ui.scene.agents.find(agent => agent.id === 'worker-live');
  assert.equal(selected.status, 'idle');
  assert.equal(selected.unconfirmedStatus, 'working');
  assert.equal(selected.showCharacter, true);
  assert.equal(selected.lastEventAt, timestamp, 'presentation aging does not change source observation time');
  assert.equal(ui.get('employee-card').hidden, false);
  const detail = ui.get('employee-detail');
  assert.equal(detail.querySelector('.status-chip').textContent, '현재 상태 미확인');
  assert.match(detail.querySelector('.unconfirmed-banner').textContent, /마지막 상태: 작업 중/u);
  assert.equal(detail.querySelector('.elapsed'), null);
  assert.equal(detail.querySelector('.tool-line'), null);
  await ui.emit(snapshot({ id: 'selected-fresh-work', timestamp: new Date(Date.now()).toISOString(), title: '다시 코드 작업' }));
  assert.equal(ui.scene.agents.find(agent => agent.id === 'worker-live').status, 'working');
  assert.equal(detail.querySelector('.unconfirmed-banner'), null);
  assert.equal(detail.querySelector('.card-section-title').textContent, '지금 하는 일');
  assert.equal(ui.scene.zoomLevel, zoom);
  assert.equal(ui.calls.slice(callsBeforeExpiry).some(call => ['focus', 'resetCamera'].includes(call[0])), false);
});

test('unconfirmed work is not renewed by model metadata, message effects or a late old report, and unresolved approvals stay visible', async t => {
  const old = '2026-01-01T09:54:00.000Z';
  const worker = snapshot({ timestamp: old, source: 'claude', model: undefined, modelEvidence: 'unknown' });
  const approval = snapshot({ id: 'old-approval', agentId: 'worker-approval', agentName: '승인 대기 직원', timestamp: old, status: 'approval' });
  const ui = await mountOffice(t, { states: [{ agents: [worker, approval], events: [] }] });
  assert.equal(ui.get('active-count').textContent, '1', 'approval requests persist until an explicit outcome is reported');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss', 'worker-approval']);
  await ui.emit({ ...worker, id: 'late-model-evidence', type: 'agent.model', referenceEventId: worker.id,
    model: 'reported-model', modelEvidence: 'reported', modelObservedAt: old, timestamp, title: '실행 모델 확인' });
  await ui.emit({ ...worker, id: 'late-message', type: 'message.sent', timestamp, title: '메시지 전달' });
  await ui.emit({ ...worker, id: 'late-old-report', timestamp: '2026-01-01T09:55:00.000Z', title: '늦게 도착한 이전 작업' });
  assert.equal(ui.get('active-count').textContent, '1', 'receipt time and metadata do not confirm current work');
  assert.equal(ui.scene.agents.some(agent => agent.id === 'worker-live' && agent.status === 'working'), false);
  ui.click('[data-open="models"]');
  assert.equal(ui.get('model-activity').querySelectorAll('.model-task').length, 0, 'model activity excludes unconfirmed work');
  ui.click('#close-panel');
  await ui.advance(300_000);
  assert.equal(ui.scene.agents.find(agent => agent.id === 'worker-approval').status, 'approval');
  await ui.emit({ ...approval, id: 'approval-finished', type: 'approval.resolved', status: 'idle', timestamp: new Date(Date.now()).toISOString() });
  assert.equal(ui.get('active-count').textContent, '0');
});

test('idle communication desks are temporary and expire without removing history', async t => {
  const recipient = snapshot({ id: 'quiet-recipient', agentId: 'worker-to', status: 'idle' });
  const ui = await mountOffice(t, { states: [{ agents: [snapshot(), recipient], events: [] }] });
  ui.click('[data-floor="project-live"]');
  assert.equal(ui.scene.agents.some(a => a.id === 'worker-to'), false);
  await ui.emit(snapshot({ id: 'temporary-desk', type: 'handoff', toAgentId: 'worker-to', timestamp: new Date(Date.now()).toISOString() }));
  await ui.advance(3000);
  assert.equal(ui.scene.agents.find(a => a.id === 'worker-to').showCharacter, false);
  assert.ok(ui.calls.some(call => call[0] === 'sendPaperPlane' && call[3] === 'temporary-desk'));
  await ui.advance(40_000);
  assert.equal(ui.scene.agents.some(a => a.id === 'worker-to'), false);
  assert.equal(ui.scene.buildingFloors[0].agents.some(a => a.id === 'worker-to'), false);
  ui.click('[data-open="communications"]');
  assert.ok(ui.get('feed').querySelector('[data-replay="temporary-desk"]'));
});

for (const suspendedBy of ['pause', 'hidden']) test(`temporary communication seats respect ${suspendedBy} animation suspension`, async t => {
  const recipient = snapshot({ id: 'quiet-recipient', agentId: 'worker-to', status: 'idle' });
  const ui = await mountOffice(t, { states: [{ agents: [snapshot(), recipient], events: [] }] });
  ui.click('[data-floor="project-live"]');
  await ui.emit(snapshot({ id: 'suspended-flight', type: 'handoff', toAgentId: 'worker-to', timestamp: new Date(Date.now()).toISOString() }));
  await ui.advance(3000);
  if (suspendedBy === 'pause') ui.click('#pause'); else await ui.setHidden(true);
  await ui.advance(40_000);
  assert.equal(ui.scene.agents.some(a => a.id === 'worker-to'), true);
  if (suspendedBy === 'pause') ui.click('#pause'); else await ui.setHidden(false);
  await ui.advance(1000);
  assert.equal(ui.scene.agents.some(a => a.id === 'worker-to'), true);
  await ui.advance(35_000);
  assert.equal(ui.scene.agents.some(a => a.id === 'worker-to'), false);
});

const clock = value => new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const localStamp = value => {
  const date = new Date(value); const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

test('employee badge card shows reported identity, current work and team, and omits rows without data', async t => {
  const started = new Date(Date.parse(timestamp) - 12 * 60_000).toISOString();
  const children = Array.from({ length: 5 }, (_, i) => snapshot({ id: `child-${i}`, agentId: `child-${i}`, agentName: `하위 직원 ${i}`,
    parentAgentId: 'worker-live', role: '개발', status: 'idle', toolName: 'Read', model: undefined, modelEvidence: 'unknown' }));
  const ui = await mountOffice(t, { states: [{ agents: [snapshot({ role: '총괄', taskStartedAt: started, activityKind: 'coding', toolName: 'Edit' }), ...children], events: [] }] });
  ui.scene.select('worker-live');
  const card = ui.get('employee-card');
  const detail = ui.get('employee-detail');
  assert.equal(card.hidden, false);
  assert.equal(card.getAttribute('role'), 'region');
  assert.equal(ui.document.getElementById(card.getAttribute('aria-labelledby')).textContent, '연결된 직원');
  assert.equal(ui.document.activeElement.id, 'employee-card-title', 'opening a card moves focus to its title');
  assert.equal(ui.scene.cardOpen, 'worker-live', 'the scene is told which person has an open card');
  assert.equal(detail.querySelector('.badge-source').textContent, 'Codex');
  assert.equal(detail.querySelector('.rank-badge').textContent, '총괄');
  assert.ok(detail.querySelector('.rank-badge').classList.contains('lead'));
  assert.equal(detail.querySelector('.model-chip').textContent, 'reported-model');
  assert.equal(detail.querySelector('[data-floor="project-live"]').textContent, '1F · 실제 프로젝트');
  assert.equal(detail.querySelector('.chat-line strong').textContent, '실제 채팅');
  const chip = detail.querySelector('.status-chip');
  assert.equal(chip.textContent, '작업 중');
  assert.equal(chip.querySelector('.status-shape').dataset.shape, 'ring');
  assert.match(chip.getAttribute('style'), new RegExp(`--status:${STATUS_STYLE.working.color}`, 'u'));
  assert.equal(detail.querySelector('.elapsed').textContent, '12분째');
  assert.match(detail.querySelector('.work-line').textContent, /코드 작업.*도구 기준 추정/u);
  assert.equal(detail.querySelector('.tool-chip').textContent, 'Edit');
  const news = detail.querySelector('.news-line > span');
  assert.equal(news.textContent, '최근 소식 · 방금');
  assert.equal(news.title, localStamp(timestamp), 'the absolute time is available on hover');
  assert.equal(detail.querySelector('.employee-task').textContent, '로컬 도구 사용');
  assert.ok(detail.querySelector('.badge-head .portrait-card svg').innerHTML.includes(appearanceFor('worker-live').skin), 'the portrait uses the same look as the 3D figure');
  assert.equal(ui.document.querySelector('.avatar') === null, true, 'the shared CSS face is gone');
  assert.deepEqual([...detail.querySelectorAll('.team-chip')].map(button => button.dataset.agent), ['child-0', 'child-1', 'child-2', 'child-3']);
  assert.equal(detail.querySelector('.team-more').textContent, '외 1명');
  assert.equal(detail.querySelector('.stale-banner') === null, true, 'a connected card has no stale banner');
  assert.equal(detail.querySelector('.card-note') === null, true, 'a working status has no guidance note');

  await ui.advance(3 * 60_000);
  assert.equal(detail.querySelector('.elapsed').textContent, '15분째', 'elapsed time follows the clock without new events');
  assert.equal(detail.querySelector('.news-line > span').textContent, '최근 소식 · 3분 전');

  ui.click('#employee-detail [data-agent="child-0"]');
  assert.equal(ui.document.getElementById('employee-card-title').textContent, '하위 직원 0');
  assert.equal(ui.document.activeElement.id, 'employee-card-title');
  assert.equal(detail.querySelector('.rank-badge').textContent, '팀원', "an adapter's default '개발' role reads as a team member");
  assert.deepEqual([...detail.querySelectorAll('.team-row')].map(row => row.textContent), ['상위연결된 직원']);
  assert.equal(detail.querySelector('.status-chip').textContent, '대기 중');
  assert.equal(detail.querySelector('.status-chip .status-shape').dataset.shape, 'bar');
  for (const selector of ['.model-chip', '.elapsed', '.tool-line', '.work-line', '.card-note']) {
    assert.equal(detail.querySelector(selector) === null, true, `${selector} is omitted without current reported data`);
  }

  ui.click('[data-open="team"]');
  ui.click('[data-roster-filter="all"]');
  const row = ui.get('roster').querySelector('[data-agent="worker-live"]');
  assert.ok(row.querySelector('.portrait-roster svg'), 'the roster uses the same portraits');
  assert.equal(row.querySelector('.employee-status .status-shape').dataset.shape, 'ring');
  assert.equal(ui.get('roster').querySelector('.status-dot') === null, true, 'roster status uses shared shapes, not dots');
});

test('closing a card returns focus to the control that opened it, including a roster row inside a closed panel', async t => {
  const ui = await mountOffice(t);
  ui.get('find-working').focus();
  ui.click('#find-working');
  assert.equal(ui.document.activeElement.id, 'employee-card-title');
  await ui.emit(snapshot({ id: 'focus-update', timestamp: '2026-01-01T10:00:30.000Z', title: '다음 도구', status: 'reviewing' }));
  assert.equal(ui.get('employee-detail').querySelector('.status-chip').textContent, '검토 중');
  assert.equal(ui.document.activeElement.id, 'employee-card-title', 'a live re-render keeps focus on the title');
  ui.key('Escape');
  assert.equal(ui.get('employee-card').hidden, true);
  assert.equal(ui.scene.cardOpen, null);
  assert.equal(ui.document.activeElement === ui.get('find-working'), true, 'closing returns focus to the opener');

  ui.click('[data-open="team"]');
  const row = ui.get('roster').querySelector('[data-agent="worker-live"]');
  row.focus(); row.click();
  assert.equal(ui.get('office-panel').open, false);
  assert.equal(ui.document.activeElement.id, 'employee-card-title');
  ui.click('#close-employee');
  assert.equal(ui.document.activeElement === ui.document.querySelector('.game-dock [data-open="team"]'), true,
    'a row inside the closed dialog falls back to the menu that opened the dialog');
});

test('the work section shows an external call, and approval and error guidance, only for the current status', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [snapshot({ toolName: 'MCP 도구', activityKind: 'research' })], events: [] }] });
  ui.scene.select('worker-live');
  const detail = ui.get('employee-detail');
  assert.equal(detail.querySelector('.work-line').textContent, '외부 서비스 연동 중');
  assert.equal(detail.querySelector('.tool-chip').textContent, 'MCP 도구');
  assert.equal(detail.querySelector('.call-note').textContent, '상대 서비스 이름은 받지 않아요', 'the unreported service name is stated, not guessed');
  const cases = [
    ['error', 'triangle', /원래 앱에서 오류를 확인해 주세요/u],
    ['approval', 'diamond', /원래 앱에서 승인하거나 거절해 주세요/u],
    ['done', 'check', null],
    ['thinking', 'dashed-ring', null],
  ];
  for (const [index, [status, shape, note]] of cases.entries()) {
    await ui.emit(snapshot({ id: `card-${status}`, status, timestamp: `2026-01-01T10:0${index + 1}:00.000Z` }));
    const chip = detail.querySelector('.status-chip');
    assert.equal(chip.textContent, STATUS_STYLE[status].label);
    assert.equal(chip.querySelector('.status-shape').dataset.shape, shape);
    assert.match(chip.getAttribute('style'), new RegExp(STATUS_STYLE[status].color, 'u'));
    if (note) assert.match(detail.querySelector('.card-note').textContent, note);
    else assert.equal(detail.querySelector('.card-note') === null, true, `${status} has no guidance note`);
    const work = detail.querySelector('.work-line')?.textContent ?? '';
    assert.equal(/외부 서비스 연동 중/u.test(work), status === 'thinking', 'a call is shown only while a working status uses the external tool');
    assert.equal(detail.querySelector('.call-note') !== null, status === 'thinking', 'the service-name note follows the call');
    assert.equal(detail.querySelector('.tool-line') !== null, status === 'thinking', 'a retained tool name is shown only for working statuses');
    if (status === 'error') assert.match(work, /자료 조사.*도구 기준 추정/u);
  }
});

test('a lost connection dims the card, keeps the last status and shows the last observation time instead of live rows', async t => {
  const started = new Date(Date.parse(timestamp) - 5 * 60_000).toISOString();
  const ui = await mountOffice(t, { states: [{ agents: [snapshot({ taskStartedAt: started, toolName: 'Edit', activityKind: 'coding' })], events: [] }] });
  ui.scene.select('worker-live');
  const detail = ui.get('employee-detail');
  assert.ok(detail.querySelector('.elapsed'));
  await ui.advance(60_000);
  ui.source.disconnect(); await ui.flush();
  assert.equal(ui.get('employee-card').classList.contains('stale'), true);
  assert.equal(detail.querySelector('.stale-banner').textContent, `연결 끊김 · 마지막 관측 ${clock(Date.parse(timestamp) + 60_000)}`);
  assert.equal(detail.querySelector('.card-section-title').textContent, '마지막으로 보인 일');
  assert.equal(detail.querySelector('.status-chip').textContent, '작업 중', 'the last reported status stays visible');
  for (const selector of ['.elapsed', '.tool-line']) assert.equal(detail.querySelector(selector) === null, true, `${selector} is not a current value while disconnected`);
  assert.match(detail.querySelector('.work-line').textContent, /코드 작업/u);
  assert.equal(detail.querySelector('.news-line > span').textContent, `최근 소식 · ${clock(timestamp)}`);
  ui.source.open(); await ui.flush();
  assert.equal(ui.get('employee-card').classList.contains('stale'), false);
  assert.equal(detail.querySelector('.stale-banner') === null, true, 'reconnecting removes the stale banner');
  assert.equal(detail.querySelector('.card-section-title').textContent, '지금 하는 일');
});

test("an employee's history link opens communications filtered to that employee and can return to everyone", async t => {
  const idle = { source: 'claude', agentId: 'worker-idle', agentName: '대기 직원', projectId: 'project-idle', projectName: '대기 프로젝트', sessionId: 'session-idle' };
  const past = [
    snapshot({ id: 'live-sent', type: 'message.sent', title: '연결된 직원의 메시지', timestamp: '2026-01-01T09:58:00.000Z' }),
    snapshot({ id: 'idle-sent', type: 'message.sent', ...idle, title: '대기 직원의 메시지', timestamp: '2026-01-01T09:57:00.000Z' }),
    snapshot({ id: 'to-live', type: 'handoff', ...idle, toAgentId: 'worker-live', title: '연결된 직원에게 전달', timestamp: '2026-01-01T09:56:00.000Z' }),
    snapshot({ id: 'idle-status', type: 'agent.status', ...idle, status: 'idle', title: '대기 직원 상태', timestamp: '2026-01-01T09:55:00.000Z' }),
  ];
  const ui = await mountOffice(t, { states: [{ agents: initialSnapshots(), events: past }] });
  ui.scene.select('worker-live');
  ui.click('#employee-detail [data-feed-agent="worker-live"]');
  assert.equal(ui.get('office-panel').open, true);
  assert.equal(ui.get('communications-panel').hidden, false);
  assert.equal(ui.get('feed-agent-filter').hidden, false);
  assert.match(ui.get('feed-agent-filter').textContent, /연결된 직원의 기록만 보는 중/u);
  assert.deepEqual([...ui.get('feed').querySelectorAll('.feed-event p')].map(line => line.textContent), ['메시지 송신 · 연결된 직원의 메시지', '연결된 직원에게 전달'],
    'records the employee sent or received');
  assert.ok(ui.document.querySelector('[data-filter="all"]').classList.contains('active'));
  ui.click('[data-feed-clear]');
  assert.equal(ui.get('feed-agent-filter').hidden, true);
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length, 4);
  ui.click('#close-panel');
  ui.scene.select('worker-idle');
  ui.click('#employee-detail [data-feed-agent="worker-idle"]');
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length, 3);
  ui.click('#close-panel');
  ui.click('#latest-dispatch');
  assert.equal(ui.get('feed-agent-filter').hidden, true, 'ordinary menus open the full history');
});

test('the owner card is a business card with current company counts and an inbox that links to people, without approval buttons', async t => {
  const at = minute => `2026-01-01T09:${minute}:00.000Z`;
  const workers = [
    snapshot(),
    snapshot({ id: 'approval-a', agentId: 'approval-a', agentName: '확인 직원 A', status: 'approval', timestamp: at(50) }),
    snapshot({ id: 'approval-b', agentId: 'approval-b', agentName: '확인 직원 B', status: 'approval', projectId: 'project-other', projectName: '다른 프로젝트', sessionId: 'session-other', timestamp: at(40) }),
    snapshot({ id: 'error-a', agentId: 'error-a', agentName: '오류 직원 A', status: 'error', timestamp: at(59) }),
    snapshot({ id: 'error-b', agentId: 'error-b', agentName: '오류 직원 B', status: 'error', timestamp: at(58) }),
    initialSnapshots()[1],
  ];
  const ui = await mountOffice(t, { states: [{ agents: workers, events: [] }] });
  ui.scene.select('boss');
  const detail = ui.get('employee-detail');
  assert.equal(ui.scene.cardOpen, 'boss');
  assert.equal(ui.document.activeElement.id, 'employee-card-title');
  assert.equal(detail.querySelector('.card-kicker').textContent, '대표 명함');
  assert.equal(detail.querySelector('.owner-company').textContent, '테스트 사무실');
  assert.equal(ui.document.getElementById('employee-card-title').textContent, '예시 사장');
  assert.equal(detail.querySelector('.owner-badge').textContent, '대표');
  assert.ok(detail.querySelector('.portrait-owner.owner-tile svg'));
  assert.equal(detail.querySelector('.status-chip, .status-dot, .status-shape[data-shape="bar"]') === null, true, 'the owner is always present, so the card has no status');
  assert.doesNotMatch(detail.textContent, /대기 중/u);
  assert.deepEqual([...detail.querySelectorAll('[data-boss-stat]')].map(cell => [cell.dataset.bossStat, cell.querySelector('b').textContent, cell.querySelector('.stat-detail')?.textContent ?? '']),
    [['working', '1', ''], ['attention', '4', '확인 요청 2 · 오류 2'], ['floors', '3', '']]);
  assert.deepEqual([...detail.querySelectorAll('.inbox-row')].map(row => [row.dataset.agent, row.querySelector('.inbox-copy > span').textContent]),
    [['approval-b', '2F · 다른 프로젝트 · 확인 요청'], ['approval-a', '1F · 실제 프로젝트 · 확인 요청'], ['error-b', '1F · 실제 프로젝트 · 오류']]);
  assert.match(detail.textContent, /총 4명 중 3명/u);
  assert.equal(ui.scene.approvalCount, 2, 'decision 49: the owner desk tray counts the same company-wide approval requests, errors excluded');
  assert.ok(ui.scene.agents.filter(agent => agent.status === 'approval').length < 2, 'the shown room alone holds fewer requests than the tray shows');
  const lamps = [...ui.document.querySelectorAll('#floor-list .floor-lamp')];
  const lampShapes = { working: 'ring', approval: 'diamond', error: 'triangle' };
  assert.equal(lamps.some(lamp => lamp.classList.contains('lit') || lamp.classList.contains('attention')), false, 'floor lamps no longer use the old green/amber classes');
  assert.equal(lamps.every(lamp => !lamp.dataset.status || lamp.dataset.shape === lampShapes[lamp.dataset.status]), true, 'each lamp carries its status shape');
  if (lamps.some(lamp => lamp.dataset.status)) {
    const byFloor = Object.fromEntries(lamps.map(lamp => [lamp.closest('[data-floor]').dataset.floor, lamp.dataset.status ?? '']));
    assert.deepEqual(byFloor, { 'project-live': 'approval', 'project-other': 'approval', 'project-idle': '' }, 'approval leads a floor that also has errors, and a quiet floor has no lamp');
  }
  assert.equal(detail.querySelector('.owner-note').textContent, '승인은 원래 앱에서 해요');
  assert.equal([...detail.querySelectorAll('button')].some(button => /승인|거절/u.test(button.textContent)), false, 'approval stays in the original app');

  ui.click('#employee-detail [data-boss-stat="attention"]');
  assert.equal(ui.document.getElementById('employee-card-title').textContent, '확인 직원 B', 'the attention count opens the first waiting person');
  ui.scene.select('boss');
  ui.click('#employee-detail .inbox-row[data-agent="error-b"]');
  assert.equal(ui.document.getElementById('employee-card-title').textContent, '오류 직원 B');
  assert.equal(ui.get('room-title').textContent, '실제 프로젝트');
  ui.scene.select('boss');
  ui.click('#employee-detail [data-boss-stat="working"]');
  assert.equal(ui.get('office-panel').open, true);
  assert.equal(ui.get('team-panel').hidden, false);
  ui.click('#close-panel');
  ui.scene.select('boss');
  ui.click('#employee-detail [data-boss-stat="floors"]');
  assert.equal(ui.scene.buildingView, true);
  assert.equal(ui.get('employee-card').hidden, true);
  assert.equal(ui.scene.cardOpen, null);

  await ui.emit(snapshot({ id: 'all-quiet', agentId: 'worker-live', status: 'idle', timestamp: '2026-01-01T10:01:00.000Z' }));
  for (const id of ['approval-a', 'approval-b', 'error-a', 'error-b']) {
    await ui.emit(snapshot({ id: `${id}-quiet`, agentId: id, status: 'idle', timestamp: '2026-01-01T10:01:00.000Z' }));
  }
  ui.scene.select('boss');
  assert.deepEqual([...detail.querySelectorAll('[data-boss-stat]')].map(cell => cell.dataset.bossStat), ['floors'], 'zero counts are omitted');
  assert.equal(detail.querySelector('.inbox-row') === null, true, 'an empty inbox is omitted entirely');
  assert.equal(detail.querySelector('.owner-note') === null, true, 'the approval note leaves with the inbox');
  ui.source.disconnect(); await ui.flush();
  assert.equal(detail.querySelector('.card-block .card-section-title').textContent, `회사 현황연결 끊김 · 마지막 관측 ${clock(Date.now())}`);
});

test('an office without connected staff still opens the owner card, reading 활동 없음', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [], events: [] }] });
  ui.scene.select('boss');
  assert.equal(ui.get('employee-card').hidden, false);
  assert.equal(ui.get('employee-detail').querySelector('.company-quiet').textContent, '활동 없음');
  assert.equal(ui.get('employee-detail').querySelector('[data-boss-stat]') === null, true, 'no zero-count cells');
});

test('decision 49: the owner desk tray follows the owner card approval count across a floor switch, a resolved request and a retirement', async t => {
  const workers = [
    snapshot(),
    snapshot({ id: 'approval-a', agentId: 'approval-a', agentName: '확인 직원 A', status: 'approval' }),
    snapshot({ id: 'approval-b', agentId: 'approval-b', agentName: '확인 직원 B', status: 'approval', projectId: 'project-other', projectName: '다른 프로젝트', sessionId: 'session-other' }),
    snapshot({ id: 'error-a', agentId: 'error-a', agentName: '오류 직원 A', status: 'error' }),
  ];
  const ui = await mountOffice(t, { states: [{ agents: workers, events: [] }] });
  const cardApprovals = () => {
    if (ui.scene.cardOpen !== 'boss') ui.scene.select('boss');
    return Number(ui.get('employee-detail').querySelector('[data-boss-stat="attention"] .stat-detail')?.textContent.match(/확인 요청 (\d+)/u)?.[1] ?? 0);
  };
  const log = [[ui.scene.approvalCount, cardApprovals()]];
  ui.click('[data-floor="project-other"]'); await ui.flush();
  log.push([ui.scene.approvalCount, cardApprovals()]);
  await ui.emit(snapshot({ id: 'approval-a-resolved', agentId: 'approval-a', agentName: '확인 직원 A', type: 'approval.resolved', status: 'working', timestamp: '2026-01-01T10:00:05.000Z' }));
  log.push([ui.scene.approvalCount, cardApprovals()]);
  await ui.emit(snapshot({ id: 'approval-b-retired', agentId: 'approval-b', agentName: '확인 직원 B', type: 'agent.retired', retired: true, status: 'idle', projectId: 'project-other', projectName: '다른 프로젝트', sessionId: 'session-other', timestamp: '2026-01-01T10:00:06.000Z' }));
  log.push([ui.scene.approvalCount, cardApprovals()]);
  assert.deepEqual(log, [[2, 2], [2, 2], [1, 1], [0, 0]]);
});

test('card styles use the shared status shapes, portraits and readable minimums', async () => {
  const css = await readFile(new URL('style.css', sourceRoot), 'utf8');
  const main = await readFile(new URL('main.ts', sourceRoot), 'utf8');
  for (const old of ['#7caa94', '#d6aa62', '#c68e82', '#87ab9e', '.avatar']) assert.equal(css.includes(old), false, `${old} was replaced by shared status shapes and portraits`);
  assert.equal(/status-dot status-\$\{/u.test(main), false, 'status markers come from statusShapeSVG');
  assert.match(css, /\.close-employee\{[^}]*width:44px;height:44px/u, 'the close control has a 44px hit area');
  const block = css.slice(css.indexOf('/* Employee badge and owner business card'));
  assert.ok(block.length > 1000);
  const sizes = [...block.matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)px/gu)].map(match => Number(match[1]));
  assert.ok(sizes.length > 20 && Math.min(...sizes) >= 11, `card text is at least 11px (${Math.min(...sizes)})`);
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const card = luminance('#f3f8fc');
  // The owner badge is light text on the dark navy badge; every other card text color sits on the light card.
  const colors = [...block.replace(/\.owner-badge\{[^}]*\}/u, '').matchAll(/[;{]color:(#[0-9a-f]{6})/giu)].map(match => match[1]);
  assert.ok(colors.includes('#52667a'));
  for (const color of colors) assert.ok((card + .05) / (luminance(color) + .05) >= 4.5, `${color} keeps 4.5:1 contrast on the card`);
});

test('the owner stays at the desk without staff, and names, bridge state and received events reach the scene', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [], events: [] }] });
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss'], 'the owner is seated before anyone connects');
  assert.equal(ui.get('empty-office').hidden, false, 'the empty-office notice stays');
  assert.deepEqual(ui.scene.ownerNames, { companyName: '테스트 사무실', ownerName: '예시 사장' }, 'the sign and nameplate use the saved names');
  assert.equal(ui.scene.bridgeHistory.at(-1), true);
  assert.equal(ui.scene.bridgeHistory.includes(false), false, 'the first connection is not reported as a reconnection');
  ui.click('[data-open="settings"]');
  ui.get('company-name').value = '새 간판 회사'; ui.get('owner-name').value = '새 대표';
  ui.get('company-form').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await ui.flush();
  assert.deepEqual(ui.scene.ownerNames, { companyName: '새 간판 회사', ownerName: '새 대표' });
  ui.click('#close-panel');
  const pulses = ui.scene.routerPulses ?? 0;
  const event = snapshot({ id: 'router-event', timestamp: new Date(Date.now()).toISOString() });
  await ui.emit(event); await ui.emit(event);
  assert.equal(ui.scene.routerPulses, pulses + 1, 'an accepted event asks for one blink and its duplicate asks for none');
  assert.deepEqual(ui.scene.agents.map(agent => agent.id), ['boss', 'worker-live']);
  ui.source.disconnect(); await ui.flush();
  assert.equal(ui.scene.bridgeHistory.at(-1), false, 'a lost bridge reaches the router LED');
  ui.source.open(); await ui.flush();
  assert.equal(ui.scene.bridgeHistory.at(-1), true);
});

test('the router LED hears nothing before the first connection result, then an unreachable bridge', async t => {
  const ui = await mountOffice(t, { autoConnect: false });
  assert.equal(ui.scene.bridgeHistory === undefined, true, 'no state is reported before the stream opens or fails');
  ui.source.disconnect(); await ui.flush();
  assert.deepEqual(ui.scene.bridgeHistory, [false]);
  ui.source.open(); await ui.flush();
  assert.equal(ui.scene.bridgeHistory.at(-1), true);
});

test('instructions leave from the owner desk only for a drawn recipient, wait out a refused owner flight, and are otherwise recorded only', async t => {
  const ui = await mountOffice(t, { instructionPlanes: true, savedSettings: { cycle: false, followWork: false } });
  const flights = () => ui.calls.filter(call => call[0] === 'sendInstructionPlane' || call[0] === 'sendMessagePlane');
  const instruction = (id, toAgentId = 'worker-live') => snapshot({ id, type: 'user.instruction', toAgentId, title: '업무 지시', timestamp: new Date(Date.now()).toISOString() });
  ui.click('[data-floor="project-live"]');
  const order = instruction('owner-order');
  await ui.emit(order); await ui.emit(order); await ui.advance(4000);
  assert.deepEqual(flights(), [['sendInstructionPlane', 'worker-live', 'owner-order']], 'one flight from the owner desk and no local copy');
  ui.scene.instructionCooldown = true;
  await ui.emit(instruction('cooling-order')); await ui.advance(4000);
  assert.deepEqual(flights().slice(1), [], 'a drawn recipient waits for the owner plane instead of bypassing its limits with a local flight');
  ui.scene.instructionCooldown = false;
  await ui.advance(1000);
  assert.deepEqual(flights().slice(1), [['sendInstructionPlane', 'worker-live', 'cooling-order']], 'the queued instruction flies once, from the owner desk');
  await ui.emit(snapshot({ id: 'quiet-arrival', agentId: 'worker-quiet', agentName: '조용한 직원', status: 'idle', timestamp: new Date(Date.now()).toISOString() }));
  await ui.emit(instruction('quiet-order', 'worker-quiet')); await ui.advance(1000);
  assert.deepEqual(flights().slice(2), [], 'decision 50: a desk kept without a drawn character gets no flight at all');
  ui.click('#building-cctv');
  await ui.emit(instruction('building-order')); await ui.advance(4000);
  assert.deepEqual(flights().slice(2), [], 'decision 50: the building view records the instruction without a flight');
  ui.click('[data-floor="project-live"]'); await ui.advance(4000);
  assert.deepEqual(flights().slice(2), [], 'a recorded-only instruction never flies later when its recipient is shown again');
  ui.click('[data-open="communications"]');
  assert.equal(ui.get('feed').querySelectorAll('.feed-event').length, 4, 'every instruction stays in the history once');
});

test('decision 50: an instruction is settled on arrival, so a recipient shown later gets no late flight and no reserved desk', async t => {
  const workers = [snapshot(), snapshot({ id: 'other-arrival', agentId: 'other-worker', agentName: '다른 층 직원', projectId: 'project-other', projectName: '다른 프로젝트', sessionId: 'session-other' })];
  const ui = await mountOffice(t, { instructionPlanes: true, states: [{ agents: workers, events: [] }], savedSettings: { cycle: false, followWork: false } });
  const flights = () => ui.calls.filter(call => call[0] === 'sendInstructionPlane' || call[0] === 'sendMessagePlane');
  const instruction = (id, toAgentId = 'worker-live') => snapshot({ id, type: 'user.instruction', toAgentId, title: id, timestamp: new Date(Date.now()).toISOString() });
  ui.click('[data-floor="project-live"]'); await ui.advance(3000);
  await ui.emit(instruction('off-floor-order', 'other-worker')); await ui.advance(3000);
  ui.click('[data-floor="project-other"]'); await ui.advance(3000);
  assert.deepEqual(flights(), [], 'a recipient off the shown room on arrival gets no flight once its floor is shown');
  ui.click('[data-floor="project-live"]'); await ui.advance(3000);
  ui.click('#building-cctv');
  await ui.emit(instruction('early-building-order')); await ui.advance(500);
  assert.equal(ui.scene.buildingView, true);
  ui.click('[data-floor="project-live"]'); await ui.advance(4000);
  assert.equal(ui.scene.buildingView, false);
  assert.deepEqual(flights(), [], 'an instruction arriving in the first moments of a building view never flies after the room returns');
  await ui.emit(snapshot({ id: 'quiet-arrival', agentId: 'worker-quiet', agentName: '조용한 직원', status: 'idle', timestamp: new Date(Date.now()).toISOString() }));
  await ui.advance(1000);
  const shown = () => ui.scene.agents.map(agent => `${agent.id}:${agent.showCharacter}`);
  const before = shown();
  await ui.emit(instruction('quiet-order', 'worker-quiet')); await ui.advance(1000);
  assert.deepEqual(shown(), before, 'a recorded-only instruction reserves no desk for a recipient without a drawn character');
  assert.deepEqual(flights(), []);
  ui.click('[data-open="communications"]');
  assert.deepEqual([...ui.get('feed').querySelectorAll('.feed-event p')].map(line => line.textContent).sort(),
    ['업무 지시 · early-building-order', '업무 지시 · off-floor-order', '업무 지시 · quiet-order'], 'every recorded-only instruction stays in the history once');
  assert.equal(ui.get('feed').querySelectorAll('[data-replay]').length, 0, 'decision 50: the history offers no flightless instruction replay');
});

test('building floors receive exact reported head counts, with finished and waiting staff counted as quiet', async t => {
  const person = (id, status, projectId = 'project-live') => snapshot({ id, agentId: id, agentName: id, status, projectId,
    projectName: projectId === 'project-live' ? '실제 프로젝트' : '두 번째 프로젝트', sessionId: `session-${projectId}` });
  const ui = await mountOffice(t, { states: [{ agents: [person('w1', 'working'), person('w2', 'thinking'), person('w3', 'reviewing'),
    person('a1', 'approval'), person('e1', 'error'), person('i1', 'idle'), person('d1', 'done'), person('q1', 'waiting'), person('o1', 'working', 'project-two')], events: [] }] });
  assert.deepEqual(ui.scene.buildingFloors.map(floor => [floor.id, floor.counts]), [
    ['project-live', { working: 3, approval: 1, error: 1, quiet: 3, unconfirmed: 0 }],
    ['project-two', { working: 1, approval: 0, error: 0, quiet: 0, unconfirmed: 0 }],
  ]);
  await ui.emit({ ...person('e1', 'working'), id: 'e1-recovered', timestamp: '2026-01-01T10:01:00.000Z' });
  assert.deepEqual(ui.scene.buildingFloors[0].counts, { working: 4, approval: 1, error: 0, quiet: 3, unconfirmed: 0 }, 'counts follow the reported status');
});

test('the first building overview rises from the ground floor once and later overviews start wide', async t => {
  const ui = await mountOffice(t);
  const shots = () => ui.scene.buildingViewHistory.filter(([enabled]) => enabled);
  assert.deepEqual(shots().slice(0, 2), [[true, 'project-live', true], [true, '', false]],
    'the camera is placed at 1F without motion, then rises to the whole building');
  assert.equal(ui.scene.reducedMotion, false, 'the motion preference is restored');
  assert.equal(ui.scene.buildingProject, '');
  ui.click('[data-floor="project-idle"]'); ui.click('#building-cctv');
  assert.deepEqual(shots().at(-1), [true, '', false]);
  assert.equal(shots().filter(([, projectId]) => projectId).length, 1, 'the crane shot plays only on first entry');
});

test('reduced motion opens the first building overview as a still wide shot', async t => {
  const ui = await mountOffice(t, { systemReducedMotion: true });
  assert.deepEqual(ui.scene.buildingViewHistory.filter(([enabled]) => enabled), [[true, '', true]]);
});

test('cards open as a collapsed bottom sheet that the grip or a vertical drag expands, and toasts keep clear of the bottom HUD', async t => {
  const ui = await mountOffice(t);
  ui.window.happyDOM.setViewport({ width: 390, height: 844 });
  const card = ui.get('employee-card'), toggle = ui.get('card-sheet-toggle'), game = ui.get('game');
  assert.equal(game.hasAttribute('data-card-sheet'), false);
  ui.scene.select('worker-live');
  assert.equal(card.dataset.sheet, 'collapsed');
  assert.equal(game.dataset.cardSheet, 'collapsed');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), 'employee-detail');
  assert.equal(ui.document.activeElement.id, 'employee-card-title', 'the title stays the focus target inside the peek');
  assert.equal(card.querySelector('.badge-head .sheet-summary').textContent, '작업 중');
  assert.equal(card.querySelector('.sheet-summary').getAttribute('aria-hidden'), 'true');
  ui.click('#card-sheet-toggle');
  assert.equal(card.dataset.sheet, 'expanded');
  assert.equal(game.dataset.cardSheet, 'expanded');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), '카드 접기');
  ui.click('#card-sheet-toggle');
  assert.equal(card.dataset.sheet, 'collapsed');

  const head = card.querySelector('.badge-head');
  const pointer = (type, clientY, target = head) => target.dispatchEvent(new ui.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', clientY }));
  pointer('pointerdown', 700); pointer('pointermove', 640);
  assert.equal(card.classList.contains('sheet-dragging'), true);
  assert.equal(card.style.getPropertyValue('--sheet-drag'), '60px', 'the sheet follows the finger');
  pointer('pointerup', 600);
  assert.equal(card.dataset.sheet, 'expanded');
  assert.equal(card.classList.contains('sheet-dragging'), false);
  assert.equal(card.style.getPropertyValue('--sheet-drag'), '');
  pointer('pointerdown', 300); pointer('pointermove', 320); pointer('pointerup', 322);
  assert.equal(card.dataset.sheet, 'expanded', 'a short movement keeps the sheet');
  ui.scene.select('worker-idle');
  assert.equal(card.dataset.sheet, 'expanded', 'moving to another person keeps the chosen height');
  pointer('pointerdown', 300, card.querySelector('.badge-head')); pointer('pointermove', 400, card.querySelector('.badge-head')); pointer('pointerup', 400, card.querySelector('.badge-head'));
  assert.equal(card.dataset.sheet, 'collapsed', 'dragging down folds the sheet');
  await ui.advance(1000);
  ui.click('#card-sheet-toggle');
  assert.equal(card.dataset.sheet, 'expanded');
  ui.key('Escape');
  assert.equal(game.hasAttribute('data-card-sheet'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  ui.scene.select('worker-live');
  assert.equal(card.dataset.sheet, 'collapsed', 'a newly opened sheet starts collapsed');
  pointer('pointerdown', 700, card.querySelector('.badge-head')); pointer('pointermove', 640, card.querySelector('.badge-head'));
  assert.equal(card.classList.contains('sheet-dragging'), true);
  ui.key('Escape');
  assert.equal(card.hidden, true, 'the card can close in the middle of a drag');
  assert.equal(card.classList.contains('sheet-dragging'), false, 'closing ends the drag');
  assert.equal(card.style.getPropertyValue('--sheet-drag'), '', 'closing drops the finger offset');
  pointer('pointerup', 600, card);
  ui.scene.select('worker-live');
  assert.equal(card.dataset.sheet, 'collapsed', 'the late pointerup chooses nothing');
  assert.equal(card.classList.contains('sheet-dragging'), false);
  assert.equal(card.style.getPropertyValue('--sheet-drag'), '', 'the reopened sheet rests at its peek height');

  const hud = ui.document.querySelector('.bottom-hud');
  hud.getBoundingClientRect = () => ({ top: ui.window.innerHeight - 176, bottom: ui.window.innerHeight - 20, height: 156, left: 0, right: 0, width: 0, x: 0, y: 0 });
  await ui.emit(snapshot({ id: 'sheet-toast', type: 'approval.requested', status: 'approval', timestamp: new Date(Date.now()).toISOString() }));
  assert.equal(ui.get('toast').hidden, false);
  assert.equal(game.style.getPropertyValue('--dock-clearance'), '176px', 'the toast clearance is the measured dock height');
  const css = await readFile(new URL('style.css', sourceRoot), 'utf8');
  assert.match(css, /\.toast\{bottom:calc\(var\(--hud-clearance\) \+ 16px\)\}/u, 'toasts sit 16px above the bottom HUD');
  assert.match(css, /\.game\{--hud-clearance:var\(--dock-clearance,\d+px\)\}/u);
  assert.match(css, /\.game\.watching\{--hud-clearance:\d+px\}/u);
  const sheetStart = css.indexOf('@media(max-width:650px),(max-height:560px){');
  assert.ok(sheetStart > 0, 'narrow and short windows share the sheet layout');
  const sheet = css.slice(sheetStart);
  assert.match(sheet, /--sheet-base:120px/u);
  assert.match(sheet, /\.employee-card\[data-sheet=expanded\]\{--sheet-base:60dvh\}/u);
  assert.match(sheet, /\.game\[data-card-sheet=collapsed\]\{--hud-clearance:120px\}/u);
  assert.match(sheet, /\.game\[data-card-sheet=expanded\]\{--hud-clearance:60dvh\}/u);
  assert.match(sheet, /\.game\[data-card-sheet=expanded\] \.scene\{transform:translateY\(min\(0px,calc\(90px - 30dvh\)\)\)\}/u,
    'the view rises only to midway between the top HUD and the open sheet');
  const sideSheetStart = css.indexOf('@media(max-height:560px) and (min-width:651px){.employee-card');
  assert.ok(sideSheetStart > sheetStart, 'short wide windows override the sheet layout');
  assert.match(css.slice(sideSheetStart).split('\n')[0], /\.game\[data-card-sheet=expanded\] \.scene\{transform:none\}/u,
    'a side sheet leaves the centre clear, so the view stays put');
});

test('a floating card ignores header drags until the window uses the bottom sheet', async t => {
  const ui = await mountOffice(t);
  ui.window.happyDOM.setViewport({ width: 1280, height: 800 });
  const card = ui.get('employee-card');
  ui.scene.select('worker-live');
  const pointer = (type, clientY) => card.querySelector('.badge-head').dispatchEvent(new ui.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', button: 0, clientY }));
  pointer('pointerdown', 700); pointer('pointermove', 640);
  assert.equal(card.classList.contains('sheet-dragging'), false, 'a desktop header drag is a text selection, not a sheet drag');
  assert.equal(card.style.getPropertyValue('--sheet-drag'), '');
  pointer('pointerup', 600);
  assert.equal(card.dataset.sheet, 'collapsed', 'the hidden sheet state is not changed from a floating card');
  assert.equal(ui.get('card-sheet-toggle').getAttribute('aria-expanded'), 'false');
  ui.window.happyDOM.setViewport({ width: 390, height: 844 });
  pointer('pointerdown', 700); pointer('pointermove', 640); pointer('pointerup', 600);
  assert.equal(card.dataset.sheet, 'expanded', 'the same drag moves the sheet once the window is narrow');
  ui.window.happyDOM.setViewport({ width: 1200, height: 520 });
  pointer('pointerdown', 600); pointer('pointermove', 660); pointer('pointerup', 700);
  assert.equal(card.dataset.sheet, 'collapsed', 'a short wide window uses the side sheet and its drag');
});

test('the first building crane waits while an office flight or an owner click may still be playing', async t => {
  const ui = await mountOffice(t, { states: [{ agents: [], events: [] }], savedSettings: { cycle: false, followWork: false } });
  const shots = () => (ui.scene.buildingViewHistory ?? []).filter(([enabled]) => enabled);
  await ui.emit(snapshot({ id: 'crane-arrival', timestamp: new Date(Date.now()).toISOString() }));
  ui.click('[data-floor="project-live"]');
  // Decision 50 gives an instruction no local stand-in flight, so a sent message provides the office flight here.
  await ui.emit(snapshot({ id: 'crane-message', type: 'message.sent', title: '실제 응답 메시지 송신', timestamp: new Date(Date.now()).toISOString() }));
  await ui.advance(4000);
  assert.equal(ui.calls.some(call => call[0] === 'sendMessagePlane'), true, 'a paper plane is flying in the office');
  ui.click('#building-cctv');
  assert.deepEqual(shots(), [[true, '', false]], 'a flying plane opens the building wide without toggling motion');
  await ui.advance(9000);
  ui.click('[data-floor="project-live"]');
  ui.get('scene').dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true }));
  ui.click('#building-cctv');
  assert.deepEqual(shots().slice(1), [[true, '', false]], 'a fresh click on the office may start an owner moment, so the crane waits again');
  await ui.advance(3500);
  ui.click('[data-floor="project-live"]'); ui.click('#building-cctv');
  assert.deepEqual(shots().slice(2), [[true, 'project-live', true], [true, '', false]], 'a calm office gets the crane it skipped');
  assert.equal(ui.scene.reducedMotion, false);
  ui.click('[data-floor="project-live"]'); ui.click('#building-cctv');
  assert.deepEqual(shots().slice(4), [[true, '', false]], 'the crane still plays only once');
});

test('a scene with its own building intro rises from 1F for three seconds without toggling motion', async t => {
  const ui = await mountOffice(t, { buildingIntro: 'play' });
  assert.deepEqual(ui.scene.introHistory, [['project-live', 3000, false]]);
  assert.equal(ui.scene.buildingViewHistory.some(([enabled, projectId, reduced]) => enabled && (projectId || reduced)), false,
    'the UI does not place the camera through reduced motion');
  ui.click('[data-floor="project-idle"]'); ui.click('#building-cctv');
  assert.equal(ui.scene.introHistory.length, 1, 'the intro plays only on first entry');
});

test('a scene that refuses its building intro opens wide and offers the intro again next time', async t => {
  const refused = await mountOffice(t, { buildingIntro: 'refuse' });
  assert.deepEqual(refused.scene.introHistory, [['project-live', 3000, false]]);
  assert.deepEqual(refused.scene.buildingViewHistory.filter(([enabled]) => enabled), [[true, '', false]], 'a refused intro opens wide');
  refused.click('[data-floor="project-idle"]'); refused.click('#building-cctv');
  assert.equal(refused.scene.introHistory.length, 2, 'a refused intro is offered again on the next entry');
});

test('communication filters expose which filter is pressed', async t => {
  const ui = await mountOffice(t);
  const pressed = () => [...ui.document.querySelectorAll('[data-filter]')].map(button => [button.dataset.filter, button.getAttribute('aria-pressed')]);
  ui.click('[data-open="communications"]');
  assert.deepEqual(pressed(), [['handoff', 'true'], ['approval', 'false'], ['all', 'false']]);
  ui.click('[data-filter="approval"]');
  assert.deepEqual(pressed(), [['handoff', 'false'], ['approval', 'true'], ['all', 'false']]);
  ui.click('#close-panel');
  ui.scene.select('worker-live');
  ui.click('#employee-detail [data-feed-agent="worker-live"]');
  assert.deepEqual(pressed(), [['handoff', 'false'], ['approval', 'false'], ['all', 'true']], "a person's history uses every record");
});
