import test from 'node:test';
import assert from 'node:assert/strict';
import { activityMessage, activityBubbleWidth, placeActivityBubbles, ACTIVITY_BUBBLE_HEIGHT } from '../src/activity-bubble.ts';

test('activity text uses observed task or tool metadata and never invents a thought', () => {
  assert.equal(activityMessage({ status: 'working', task: '  src/app.ts 수정 중\n입력 검증 추가  ', toolName: 'Edit' }).fullText,
    'src/app.ts 수정 중 입력 검증 추가');
  assert.equal(activityMessage({ status: 'working', toolName: 'Read' }).text, 'Read 사용 중');
  assert.equal(activityMessage({ status: 'thinking', toolName: 'Read' }).text, '처리 중');
  assert.equal(activityMessage({ status: 'reviewing' }).text, '검토 중');
  assert.equal(activityMessage({ status: 'approval' }).text, '확인 요청');
  assert.equal(activityMessage({ status: 'error' }).text, '오류');
  assert.equal(activityMessage({ status: 'unobserved' }).text, '');
});

test('ended or idle agents do not keep announcing their previous tool as current work', () => {
  for (const status of ['idle', 'waiting']) {
    assert.deepEqual(activityMessage({ status, task: '오래된 파일 수정 중', toolName: 'Edit', activityKind: 'coding' }),
      { text: '', compactText: '', fullText: '' });
  }
  assert.equal(activityMessage({ status: 'done', task: '오래된 파일 수정 중', toolName: 'Edit' }).text, '응답 종료');
});

test('short bubbles preserve whole emoji and clean control characters without treating metadata as markup', () => {
  const family = '👨‍👩‍👧‍👦';
  const result = activityMessage({ status: 'working', task: `${family.repeat(35)} 확인 중` });
  const split = text => [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
  assert.equal(split(result.text).length, 28);
  assert.equal(split(result.compactText).length, 18);
  assert.ok(result.text.endsWith('…'));
  assert.equal(split(result.compactText)[0], family);
  assert.equal(activityMessage({ status: 'working', task: 'Read\u0000\u202e 완료' }).text, 'Read 완료');
  assert.equal(activityMessage({ status: 'working', task: '<b>Read</b>' }).text, '<b>Read</b>', 'metadata stays literal text for the scene textContent assignment');
  assert.ok(activityBubbleWidth(result.compactText, true) <= 174);
  assert.ok(activityBubbleWidth(result.text, false) <= 220);
});

const candidate = (id, x, y, options = {}) => ({ id, x, y, width: 150, priority: 50, nameVisible: false, ...options });

test('crowded bubbles remain readable with selected and approval activity ahead of ordinary work', () => {
  const candidates = [candidate('ordinary', 220, 200), candidate('approval', 220, 200, { priority: 70 }),
    candidate('selected', 220, 200, { priority: 100 }), candidate('separate', 500, 350)];
  const placed = placeActivityBubbles(candidates, 800, 600, new Set(['ordinary']));
  assert.deepEqual(placed.map(item => item.id), ['selected', 'separate']);
  const stable = placeActivityBubbles([candidate('new', 220, 200), candidate('previous', 220, 200)], 800, 600, new Set(['previous']));
  assert.equal(stable[0].id, 'previous', 'equal-priority text does not flicker when the camera moves slightly');
});

test('viewport clipping, edge tails and name clearance keep text inside the camera and off name badges', () => {
  const placed = placeActivityBubbles([candidate('left-edge', 2, 100), candidate('outside', -1, 300),
    candidate('above', 400, 20, { nameVisible: true }), candidate('below', 400, 601), candidate('bad', NaN, 100)], 800, 600);
  assert.deepEqual(placed.map(item => item.id), ['left-edge']);
  assert.equal(placed[0].left, 8);
  assert.ok(placed[0].tailX >= 12);
  const withName = placeActivityBubbles([candidate('worker', 300, 200, { nameVisible: true })], 800, 600)[0];
  const withoutName = placeActivityBubbles([candidate('worker', 300, 200)], 800, 600)[0];
  assert.equal(withoutName.top - withName.top, 22);
  assert.ok(withName.top + ACTIVITY_BUBBLE_HEIGHT < 200 - 24);
  const crowded = placeActivityBubbles([candidate('speaker', 300, 200, { priority: 100, nameVisible: true }),
    candidate('upper-name', 300, 160, { nameVisible: true })], 800, 600);
  assert.ok(!crowded.some(item => item.id === 'speaker'), 'a speech balloon cannot cover the next employee name');
});

test('an external service call reads as a call in the 3D bubble, while approval, errors and quiet statuses keep their own text', () => {
  for (const status of ['working', 'thinking', 'reviewing']) {
    assert.equal(activityMessage({ status, toolName: 'MCP 도구', activityKind: 'research', task: '도구 호출' }).text, '외부 서비스 연동 중', status);
  }
  assert.equal(activityMessage({ status: 'approval', toolName: 'MCP 도구', activityKind: 'research' }).text, '자료 조사 · 확인 요청');
  assert.equal(activityMessage({ status: 'error', toolName: 'MCP 도구' }).text, '오류');
  assert.equal(activityMessage({ status: 'idle', toolName: 'MCP 도구', activityKind: 'research' }).text, '');
  assert.equal(activityMessage({ status: 'working', toolName: 'mcp 도구' }).text, 'mcp 도구 사용 중', 'only the exact reported tool name is a call');
});
