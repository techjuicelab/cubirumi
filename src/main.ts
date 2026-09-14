import './style.css';
import { normalizeCompanySettings, loadCompanySettings, saveCompanySettings, renderCompanySettings, type CompanySettings } from './company-settings';
import { OfficeScene } from './office-scene';
import { sourceNames, observationNames, activityNames, type Agent, type OfficeEvent } from './protocol';
import { statusStyleFor, presentedStatusStyle, isExternalCall, UNCONFIRMED_STYLE, EXTERNAL_CALL_LABEL } from './status-style';
import { isWorkingStatus } from './work-activity';
import { portraitSVG, statusShapeSVG } from './portrait';
import { owner, projectKey, sessionKey, updateAgentState, isWorkingAgent } from './office-state';
import { connectedAgents, cctvRooms, modelActivity, hasVisibleActivity } from './observation';
import { presentAgentActivity } from './activity-freshness';
import { defaultViewSettings, readViewSettings, saveViewSettings } from './view-settings';
import { shell, icon } from './shell';
import { CameraDirector } from './camera-director';
import { BuildingDirector } from './building-director';
import { HandoffPlayback, communicationEndpoints } from './handoff-playback';
import { unavailableUsage, parseUsage, type ProviderUsage } from './usage-view';
import { renderEnergyCards, renderUsageDetails, usageSectionId } from './usage-ui';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '시간 미확인'; };
const pad2 = (value: number) => String(value).padStart(2, '0');
const absoluteTime = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}` : '';
};
// Cards speak in relative time; only a lost connection shows the actual clock time it was last observed.
const relativeTime = (value: string, now = Date.now()) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '시간 미확인';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  return minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전` : `${Math.floor(minutes / 1440)}일 전`;
};
const statusLabel = (agent: Agent) => presentedStatusStyle(agent).label;
const modelName = (agent: Agent) => agent.modelEvidence === 'reported' && agent.model ? agent.model : '모델 미확인';
document.querySelector<HTMLDivElement>('#app')!.innerHTML = shell;
// Fullscreen renders only descendants of its element, including dialogs and status messages.
el('game').append(el('office-panel'), el('toast'));

let companySettings = normalizeCompanySettings({});
let companyName = companySettings.companyName;
const companyOwner = () => ({ ...owner(), name: companySettings.ownerName });
let agents: Agent[] = [companyOwner()];
let companyFormDirty = false;
let companySaving = false;
let companyRevision = 0;
let companyLoadId = 0;
let events: OfficeEvent[] = [];
const seen = new Set<string>();
let selectedProject = '';
let selectedSession = '';
const ALL_SESSIONS = '__all_sessions__';
let cameraScope: 'building' | 'floor' = 'building';
const director = new CameraDirector();
const buildingDirector = new BuildingDirector();
let overviewUntil = 0;
const handoffs = new HandoffPlayback();
// Real communication endpoints may keep a desk briefly while the flight is queued or playing.
const communicationSeats = new Map<string, number>();
let buildingWide = false;
let hasShownBuilding = false;
let buildingWideStarted = 0;
let buildingWideUntil = 0;
let nextBuildingWideAt = 0;
let manualUntil = 0;
// Set while the user keeps a view they zoomed into; automatic camera changes wait until they zoom out or pick a place.
let zoomLock = false;
let handoffReadyAt = 0;
let replaySequence = 0;
let replayUntil = 0;
let usage: ProviderUsage[] = unavailableUsage();
let usageInFlight = false;
let usageLastRequested = -Infinity;
let usageUnavailable = false;
let selectedAgent = '';
let panel = '';
let filter = 'handoff';
// Set by an employee card's history link; empty means every employee's records.
let feedAgent = '';
let rosterFilter: 'active' | 'all' = 'active';
let bridgeConnected = false;
// The router LED hears the bridge only after the first open or error, so the first connection is not shown as a reconnection.
let bridgeObserved = false;
// When the bridge was last known to be connected; cards show it as the last observation time.
let disconnectedAt = '';
// Focus returns here when the card closes (the element, a selector if it was re-rendered, and the panel it lived in).
let cardOpener: { element: HTMLElement; selector: string | null; panel: string } | null = null;
let stateLoaded = false;
let stateAvailable = false;
let paused = false;
let seatClock = 0, seatClockUpdatedAt = Date.now();
let seatClockSuspended: boolean = document.hidden || !bridgeConnected;
// Observation starts only through its controls, including when an older launcher supplies watch=1.
let watch = false;
let observationMotion: boolean | undefined;
let lastCameraKey = '';
let renderPending = false;
let renderedFreshness = '';
let disposed = false;
let toastTimer: ReturnType<typeof setTimeout>;
/** Scene methods from the 3D branch contract. Every call is optional so the UI runs with any scene build. */
type SceneContract = {
  setOwnerNames?: (names: { companyName: string; ownerName: string }) => void;
  setBridgeConnected?: (connected: boolean) => void;
  pulseRouter?: () => void;
  setCardOpen?: (agentId: string | null) => void;
  sendInstructionPlane?: (toAgentId: string, eventId: string) => boolean;
  /** Requested from the 3D branch: shows the building from the given floor and rises to the whole building; false when it cannot play. */
  playBuildingIntro?: (fromProjectId: string, durationMs: number) => boolean;
  /** Decision 49: the owner's desk tray counts the company's current approval requests, like the owner card's inbox. */
  setApprovalCount?: (count: number) => void;
};
let scene: (OfficeScene & SceneContract) | undefined;
// The first building overview of a page rises from the ground floor once.
let craneShown = false;
// Until this time an office paper flight or an owner moment may still be playing (see showBuildingCrane).
let sceneBusyUntil = 0;
// Bottom-sheet cards (narrow or short windows) open collapsed; the grip or a vertical drag expands them.
let cardSheetExpanded = false;
let sheetDrag: { pointerId: number; startY: number; moved: boolean } | null = null;
let sheetDragEndedAt = -Infinity;
// Mirrors the CSS media query list that turns the card into a bottom sheet; other layouts ignore sheet drags.
// The two queries are kept apart because some DOM implementations do not evaluate comma-separated lists.
const narrowSheetQuery = matchMedia('(max-width:650px)'), shortSheetQuery = matchMedia('(max-height:560px)');
const sheetLayout = { get matches() { return narrowSheetQuery.matches || shortSheetQuery.matches; } };
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let settings = defaultViewSettings(motionPreference.matches);
try { settings = readViewSettings(localStorage, motionPreference.matches); } catch { /* Storage can be blocked by the browser. */ }
try { scene = new OfficeScene(el('scene'), selectAgent, id => pickRoom(id)); }
catch (error) {
  el('scene').innerHTML = '<div class="webgl-error"><strong>3D 화면을 열지 못했어요</strong><p>브라우저의 그래픽 가속을 켜고 새로고침해주세요.<br>직원과 소통 기록은 아래 메뉴에서 볼 수 있어요.</p></div>';
  console.error('3D 초기화 실패', error);
}
scene?.setOwnerNames?.({ companyName: companySettings.companyName, ownerName: companySettings.ownerName });
function placeToast() {
  const dialog = el<HTMLDialogElement>('office-panel');
  const target = dialog.open ? dialog : el('game');
  if (el('toast').parentElement !== target) target.append(el('toast'));
  el('toast').classList.toggle('in-dialog', dialog.open);
}
/** Measures the dock so toasts keep 16px above it; the card sheet and observation bar use CSS clearances. */
function measureDockClearance() {
  const game = el('game');
  const rect = document.querySelector<HTMLElement>('.bottom-hud')?.getBoundingClientRect();
  if (rect && rect.height > 0 && window.innerHeight > 0) game.style.setProperty('--dock-clearance', `${Math.max(0, Math.round(window.innerHeight - rect.top))}px`);
  else game.style.removeProperty('--dock-clearance');
}
/**
 * Publishes the usage HUD's bottom edge (CSS --energy-bottom): desktop cards stop below it, and the camera tools and the elevator
 * floor rail sit under it, so a taller usage HUD moves them down instead of covering the zoom button.
 */
function measureEnergyClearance() {
  const game = el('game'), hud = document.getElementById('energy-hud');
  const rect = hud?.getBoundingClientRect(), frame = game.getBoundingClientRect();
  if (rect && rect.height > 0) game.style.setProperty('--energy-bottom', `${Math.max(0, Math.round(rect.bottom - frame.top))}px`);
  else game.style.removeProperty('--energy-bottom');
}
/**
 * The laid-out rect of a HUD block, or null while it is not drawn. The controls hint only steps aside for a toast (style.css), so
 * it keeps its place in the measurements then: a toast never lets the building or the floor rail grow into the hint's place.
 */
function hudRect(selector: string): DOMRect | null {
  const node = document.querySelector<HTMLElement>(selector);
  const rect = node?.getBoundingClientRect();
  if (!node || !rect || !(rect.width > 0 && rect.height > 0)) return null;
  const style = window.getComputedStyle(node);
  if (style.display === 'none') return null;
  if (style.visibility !== 'hidden') return rect;
  return selector === '.scene-hint' && !watch && !el('game').dataset.cardSheet && !el('toast').hidden ? rect : null;
}
/**
 * Publishes how far the bottom blocks sharing the camera tools' column reach up from the bottom edge (CSS --tools-clearance), so
 * in a short narrow window the tools stop above the dock. The tools' column does not depend on that height.
 */
function measureToolsClearance() {
  const game = el('game'), frame = game.getBoundingClientRect(), tools = hudRect('.camera-tools');
  if (!tools || !(frame.height > 0)) { game.style.removeProperty('--tools-clearance'); return; }
  let clearance = 0;
  for (const selector of ['.bottom-hud', '.scene-hint', '.watch-overlay']) {
    const rect = hudRect(selector);
    if (rect && rect.left < tools.right && rect.right > tools.left) clearance = Math.max(clearance, frame.bottom - rect.top);
  }
  game.style.setProperty('--tools-clearance', `${Math.ceil(clearance)}px`);
}
/**
 * Right edge of the floor caption reported for the fit beside it, kept `CAPTION_EDGE_HEADROOM` px right of the caption when it
 * moves: a caption up to that much wider or narrower (a two-digit head count, another mode line) keeps the edge, so the building
 * does not jump. A wider caption past the headroom moves it at once, a narrower one past `CAPTION_EDGE_SLACK` px below the edge
 * moves it back; the edge never lies left of the caption. A new building visit or an observation toggle starts over.
 */
let captionEdge = 0, captionLayout = '';
const CAPTION_EDGE_SLACK = 24, CAPTION_EDGE_HEADROOM = 8;
/**
 * Building shots fit the whole model between the HUD blocks, reported to the scene in CSS pixels from each stage edge. The floor
 * caption only takes the top left corner, so the report also carries the insets with the caption as a left block under the HUD
 * edge above it (decision 53); the scene fits the building there in short windows where that draws it clearly larger.
 */
function measureSceneInsets() {
  // The camera tools and the floor rail follow the usage HUD in every shot, so its edge is current before they are measured.
  measureEnergyClearance();
  measureToolsClearance();
  if (!scene || !buildingWide) { captionEdge = 0; captionLayout = ''; return; }
  const layout = watch ? 'watching' : 'building';
  if (layout !== captionLayout) { captionLayout = layout; captionEdge = 0; }
  const frame = el('game').getBoundingClientRect();
  if (!(frame.width > 0 && frame.height > 0)) return;
  const shown = hudRect;
  let upper = 0, bottom = 0, railFloor = 0;
  // Above: the company plate and, in narrow windows, the project selector. Below: the news strip, the controls hint and the dock,
  // or the observation bar.
  for (const selector of ['.top-hud', '.project-select']) {
    const rect = shown(selector);
    if (rect) upper = Math.max(upper, rect.bottom - frame.top);
  }
  // The elevator rail of a tall building ends above the bottom blocks that share its column (CSS --rail-floor). Its column does
  // not depend on that height, so it is read before the property changes.
  const rail = shown('.building-floor-rail');
  for (const selector of ['.bottom-hud', '.scene-hint', '.watch-overlay']) {
    const rect = shown(selector);
    if (!rect) continue;
    bottom = Math.max(bottom, frame.bottom - rect.top);
    if (rail && rect.left < rail.right && rect.right > rail.left) railFloor = Math.max(railFloor, frame.bottom - rect.top);
  }
  if (rail) el('game').style.setProperty('--rail-floor', `${Math.ceil(railFloor)}px`);
  else el('game').style.removeProperty('--rail-floor');
  const caption = shown('.scene-location');
  const top = caption ? Math.max(upper, caption.bottom - frame.top) : upper;
  // Side blocks narrow the stage only where they cover a real share of the free band between the top edge and the bottom HUD.
  const sides = (edge: number) => {
    const bandTop = frame.top + edge, bandBottom = frame.bottom - bottom;
    let left = 0, right = 0;
    for (const selector of ['.floor-rail', '.energy-hud', '.camera-tools', '.building-floor-rail']) {
      const rect = shown(selector);
      if (!rect || Math.min(rect.bottom, bandBottom) - Math.max(rect.top, bandTop) < (bandBottom - bandTop) * .25) continue;
      if (rect.left + rect.right < frame.left + frame.right) left = Math.max(left, rect.right - frame.left);
      else right = Math.max(right, frame.right - rect.left);
    }
    return { left, right };
  };
  const { left, right } = sides(top);
  let beside: { top: number; right: number; bottom: number; left: number } | null = null;
  if (caption && top > upper) {
    // The reported edge never lies left of the caption, and small width changes of its text do not refit the building.
    const edge = Math.ceil(caption.right - frame.left);
    if (edge > captionEdge || edge < captionEdge - CAPTION_EDGE_SLACK) captionEdge = edge + CAPTION_EDGE_HEADROOM;
    const raised = sides(upper);
    beside = { top: upper, right: raised.right, bottom, left: Math.max(raised.left, captionEdge) };
  }
  scene.setHudInsets?.({ top, right, bottom, left, beside });
}
function toast(message: string) {
  clearTimeout(toastTimer); measureDockClearance(); placeToast(); el('toast').hidden = false; el('toast').textContent = message;
  toastTimer = setTimeout(() => { el('toast').hidden = true; }, 4500);
}
// Project observed records for the live view; time alone never writes a completion or changes the source state.
function staff(now = Date.now()) { return connectedAgents(agents).map(agent => presentAgentActivity(agent, now)); }
function freshnessKey() { return JSON.stringify(staff().filter(agent => agent.unconfirmedStatus).map(agent => [agent.source, agent.id, agent.unconfirmedStatus])); }
/** Exact connected head counts for a floor; quiet is connected but idle, waiting or finished responding. */
function floorCounts(list: Agent[]) {
  const counts = { working: 0, approval: 0, error: 0, quiet: 0, unconfirmed: 0 };
  for (const agent of list) {
    if (agent.unconfirmedStatus) counts.unconfirmed++;
    else if (isWorkingStatus(agent.status)) counts.working++;
    else if (agent.status === 'approval') counts.approval++;
    else if (agent.status === 'error') counts.error++;
    else counts.quiet++;
  }
  return counts;
}
function floors() {
  const groups = new Map<string, { id: string; name: string; agents: Agent[] }>();
  for (const agent of staff()) {
    const id = projectKey(agent);
    const group = groups.get(id) ?? { id, name: agent.projectName ?? '프로젝트 미확인', agents: [] };
    group.agents.push(agent); groups.set(id, group);
  }
  return [...groups.values()].map(group => ({ ...group, counts: floorCounts(group.agents) }));
}
function rooms() {
  const groups = new Map<string, { id: string; name: string; agents: Agent[] }>();
  for (const agent of staff().filter(a => projectKey(a) === selectedProject)) {
    const id = sessionKey(agent);
    const group = groups.get(id) ?? { id, name: agent.sessionName ?? (agent.sessionId ? `채팅 ${agent.sessionId.slice(0, 8)}` : '채팅 미확인'), agents: [] };
    group.agents.push(agent); groups.set(id, group);
  }
  return [...groups.values()];
}
function defaultSession(currentRooms: ReturnType<typeof rooms>) {
  return currentRooms.length > 1 ? ALL_SESSIONS : currentRooms[0]?.id ?? '';
}
function roomLabel(room: ReturnType<typeof rooms>[number]) {
  const sources = [...new Set(room.agents.map(agent => sourceNames[agent.source]))];
  return `${sources.join(' · ')} · ${room.name}`;
}
function roomStaff() { return staff().filter(a => projectKey(a) === selectedProject && (selectedSession === ALL_SESSIONS || sessionKey(a) === selectedSession)); }
function visibleStaff() { return roomStaff(); }
function attentionCount(currentStaff: Agent[]) { return currentStaff.filter(agent => agent.status === 'approval' || agent.status === 'error').length; }
function activityRank(agent: Agent) { return agent.status === 'approval' ? 0 : agent.status === 'error' ? 1 : isWorkingAgent(agent) ? 2 : 3; }
function activitySummary(currentStaff: Agent[]) {
  const working = currentStaff.filter(isWorkingAgent).length;
  const attention = attentionCount(currentStaff);
  const unconfirmed = currentStaff.filter(agent => agent.unconfirmedStatus).length;
  const quiet = currentStaff.length - working - attention - unconfirmed;
  // Decision 35: a zero count is left out, and nothing to report reads '활동 없음' like the floor plates and the owner card.
  return [...(working ? [`${working}명 작업 중`] : []), ...(attention ? [`${attention}명 확인 필요`] : []), ...(quiet ? [`${quiet}명 대기`] : []), ...(unconfirmed ? [`${unconfirmed}명 상태 미확인`] : [])].join(' · ') || '활동 없음';
}
/** A person is drawn at their desk while their reported activity is visible or their card is open. */
function drawsCharacter(agent: Agent) { return hasVisibleActivity(agent) || agent.id === selectedAgent; }
function sceneStaff(currentStaff: Agent[]) {
  const now = communicationTime();
  return currentStaff.filter(agent => drawsCharacter(agent) || (communicationSeats.get(agent.id) ?? 0) > now)
    .map(agent => ({ ...agent, showCharacter: drawsCharacter(agent) }));
}
function communicationTime() {
  const now = Date.now();
  if (!seatClockSuspended) seatClock += Math.max(0, now - seatClockUpdatedAt);
  seatClockUpdatedAt = now;
  seatClockSuspended = paused || document.hidden || !bridgeConnected;
  return seatClock;
}
function reserveCommunicationSeats(entry: OfficeEvent, duration: number) {
  const until = communicationTime() + duration;
  for (const id of communicationEndpoints(entry)) {
    if (staff().some(agent => agent.id === id)) communicationSeats.set(id, Math.max(communicationSeats.get(id) ?? 0, until));
  }
  while (communicationSeats.size > 512) communicationSeats.delete(communicationSeats.keys().next().value!);
}
function currentCameraKey() { return `${selectedProject}/${selectedSession}`; }
function resetCycle() { buildingDirector.hold(Date.now(), settings.cycleSeconds * 1000); }
function beginBuildingOverview() {
  if (!staff().length) return;
  const now = Date.now();
  buildingWide = true; buildingWideStarted = now; buildingWideUntil = now + 10_000;
  hasShownBuilding = true;
  overviewUntil = buildingWideUntil + 5500;
  if (craneShown) scene?.setBuildingView(true); else showBuildingCrane();
  renderNavigation();
}
const CRANE_MS = 3000;
/** Office flights last at most about 8s (7s flight and the receipt); an owner click moment or a five-click spin fits in 3s. */
function markSceneBusy(milliseconds: number) { sceneBusyUntil = Math.max(sceneBusyUntil, Date.now() + milliseconds); }
/** First entry only: start close on the ground floor and rise to the whole building. Reduced motion opens a still wide shot. */
function showBuildingCrane() {
  const ground = floors()[0]?.id;
  if (!scene || settings.reducedMotion || !ground) { craneShown = true; scene?.setBuildingView(true); return; }
  if (scene.playBuildingIntro) {
    // A scene that refuses the intro opens wide and keeps the crane for a later entry.
    if (scene.playBuildingIntro(ground, CRANE_MS)) craneShown = true; else scene.setBuildingView(true);
    return;
  }
  // Fallback for scenes without the intro: reduced motion places the camera without moving and restoring it animates the next
  // shot (about 2.6s). That toggle also lands office flights and cancels owner moments, so a busy office opens wide instead.
  if (Date.now() < sceneBusyUntil) { scene.setBuildingView(true); return; }
  craneShown = true;
  scene.setReducedMotion(true); scene.setBuildingView(true, ground);
  scene.setReducedMotion(settings.reducedMotion); scene.setBuildingView(true);
}
function finishBuildingOverview() {
  buildingWide = false; scene?.setBuildingView(false);
  scene?.focus(null, { cinematic: true }); director.roomChanged();
  overviewUntil = Date.now() + 5500;
  nextBuildingWideAt = Date.now() + Math.max(30, settings.cycleSeconds * 2) * 1000;
  renderNavigation();
}
function pickRoom(projectId: string, sessionId?: string, automatic = false) {
  if (!automatic) { setWatch(false); cameraScope = 'floor'; setZoomLock(false); }
  buildingWide = false; scene?.setBuildingView(false);
  selectedProject = projectId;
  const currentRooms = rooms();
  selectedSession = sessionId ?? defaultSession(currentRooms);
  closeEmployee(); if (!automatic) { resetCycle(); director.hold(Date.now(), 5500); }
  overviewUntil = Date.now() + 5500;
  renderAll(); scene?.focus(null, { cinematic: true, zoom: 1 });
}
function watchBuilding() {
  setWatch(false);
  manualUntil = 0; setZoomLock(false);
  cameraScope = 'building'; closeEmployee(); buildingDirector.reset(); resetCycle();
  director.roomChanged(); renderAll(); beginBuildingOverview();
}
function patrolRooms() {
  return cctvRooms(staff().filter(hasVisibleActivity)).filter(room => cameraScope === 'building' || room.projectId === selectedProject);
}
function activeFloorCount(candidates = patrolRooms()) { return new Set(candidates.map(room => room.projectId)).size; }
function alignWatchWithActivity(candidates = patrolRooms()) {
  if (!candidates.length || candidates.some(room => room.projectId === selectedProject
    && (selectedSession === ALL_SESSIONS || room.sessionId === selectedSession))) return;
  const room = candidates[0]!;
  pickRoom(room.projectId, room.sessionId, true);
  resetCycle();
}
function normalizeSelection() {
  const currentFloors = floors();
  if (!currentFloors.some(floor => floor.id === selectedProject)) {
    const preferred = currentFloors.find(floor => floor.agents.some(hasVisibleActivity)) ?? currentFloors[0];
    selectedProject = preferred?.id ?? ''; selectedSession = '';
  }
  const currentRooms = rooms();
  if (!(selectedSession === ALL_SESSIONS && currentRooms.length) && !currentRooms.some(room => room.id === selectedSession)) {
    selectedSession = defaultSession(currentRooms);
  }
}
const renderedHTML = new WeakMap<HTMLElement, { requested: string; serialized: string }>();
// Dataset key and attribute name of every control that can be re-rendered while focused.
const FOCUS_KEYS = [['agent', 'agent'], ['replay', 'replay'], ['feedAgent', 'feed-agent'], ['bossStat', 'boss-stat'], ['feedClear', 'feed-clear'], ['open', 'open'], ['floor', 'floor']] as const;
function focusSelector(element: HTMLElement | null) {
  if (!element) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const entry = FOCUS_KEYS.find(([key]) => element.dataset[key]);
  return entry ? `[data-${entry[1]}="${CSS.escape(element.dataset[entry[0]]!)}"]` : null;
}
function syncHTML(target: HTMLElement, markup: string) {
  const previous = renderedHTML.get(target);
  if (previous?.requested === markup && previous.serialized === target.innerHTML) return;
  const focused = document.activeElement instanceof HTMLElement && target.contains(document.activeElement) ? document.activeElement : null;
  const key = focusSelector(focused);
  const scrollTop = target.scrollTop;
  target.innerHTML = markup;
  renderedHTML.set(target, { requested: markup, serialized: target.innerHTML });
  target.scrollTop = scrollTop;
  if (key) target.querySelector<HTMLElement>(key)?.focus({ preventScroll: true });
}
function renderNavigation() {
  const currentFloors = floors();
  const currentRooms = rooms();
  const index = currentFloors.findIndex(floor => floor.id === selectedProject);
  const floor = currentFloors[index];
  const room = currentRooms.find(room => room.id === selectedSession);
  const viewName = selectedSession === ALL_SESSIONS ? '모든 채팅' : room ? roomLabel(room) : '';
  el('floor-count').textContent = String(currentFloors.length);
  el('game').dataset.cameraScope = cameraScope;
  el('game').dataset.shot = buildingWide ? 'building' : 'room';
  // The building view is a two-step click (floor, then person), so its hint names both steps.
  const hint = document.querySelector<HTMLElement>('.scene-hint');
  if (hint) syncHTML(hint, buildingWide ? '드래그로 360° 회전 <span>·</span> 층을 눌러 고르기 <span>·</span> 직원을 눌러 사무실로'
    : '드래그로 360° 회전 <span>·</span> 휠로 확대 <span>·</span> 직원을 눌러 가까이');
  el('camera-scope').textContent = '건물 전체 보기';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-building-cctv]')) {
    button.setAttribute('aria-pressed', String(buildingWide && !watch));
  }
  syncHTML(el('floor-list'), currentFloors.map((item, i) => {
    const attention = attentionCount(item.agents), working = item.agents.filter(isWorkingAgent).length;
    const summary = [...(working ? [`${working}명 작업 중`] : []), ...(attention ? [`${attention}명 확인 필요`] : [])].join(' · ') || '활동 없음';
    // Same order as the owner inbox (approval before error), with the shared table's colour and shape.
    const lampStatus = !bridgeConnected ? '' : item.agents.some(agent => agent.status === 'approval') ? 'approval'
      : item.agents.some(agent => agent.status === 'error') ? 'error' : working ? 'working' : '';
    const lamp = lampStatus ? ` data-status="${lampStatus}" data-shape="${statusStyleFor(lampStatus).shape}"` : '';
    return `<button class="floor-button ${item.id === selectedProject ? 'selected' : ''}" data-floor="${escape(item.id)}" aria-label="${i + 1}층 ${escape(item.name)} · ${summary}" aria-pressed="${item.id === selectedProject}" title="${escape(item.name)} · ${summary}"><span class="floor-digit">${i + 1}<small>F</small></span><span class="floor-info"><strong>${escape(item.name)}</strong><small>${summary}</small></span><i class="floor-lamp"${lamp}></i></button>`;
  }).join('') || '<span class="rail-empty">—</span>');
  syncHTML(el('project-select'), currentFloors.map((item, i) => `<option value="${escape(item.id)}">${i + 1}F · ${escape(item.name)}</option>`).join(''));
  el<HTMLSelectElement>('project-select').value = selectedProject;
  el<HTMLSelectElement>('project-select').disabled = !currentFloors.length;
  el('floor-number').textContent = floor ? `${index + 1}F` : '—';
  el('room-title').textContent = floor?.name ?? '출근을 기다리는 사무실';
  const selector = el<HTMLSelectElement>('session-select');
  const allOption = currentRooms.length > 1 || selectedSession === ALL_SESSIONS ? `<option value="${ALL_SESSIONS}">모든 채팅</option>` : '';
  syncHTML(selector, allOption + currentRooms.map(item => `<option value="${escape(item.id)}">${escape(roomLabel(item))}</option>`).join(''));
  selector.value = selectedSession; selector.hidden = !currentRooms.length;
  selector.setAttribute('aria-label', `채팅 작업구역 ${currentRooms.length}개`);
  el('room-count').textContent = currentRooms.length ? `${currentRooms.length}개 사무실` : '';
  const roomActivity = activitySummary(visibleStaff());
  el('room-activity').textContent = roomActivity;
  el('staff-count').textContent = String(staff().length);
  el('active-count').textContent = bridgeConnected ? String(staff().filter(hasVisibleActivity).length) : '—';
  el('roster-active-count').textContent = String(staff().filter(hasVisibleActivity).length);
  el('roster-summary').textContent = bridgeConnected ? activitySummary(staff()) : `연결 끊김 · 마지막으로 관측한 ${staff().length}명의 상태`;
  el<HTMLButtonElement>('find-working').disabled = !staff().some(hasVisibleActivity);
  el('find-working').title = attentionCount(staff()) ? '승인·오류 확인이 필요한 직원에게 이동' : '작업 중인 직원에게 이동';
  el('empty-office').hidden = !!staff().length || !stateLoaded;
  el('watch-caption').textContent = `${floor ? `${index + 1}F · ${floor.name}` : companyName}${viewName ? ` · ${viewName}` : ''}`;
  const wideFocus = watch && buildingWide && Date.now() - buildingWideStarted > 3500;
  el('location-floor').textContent = buildingWide && !wideFocus ? `${currentFloors.length}개 층` : floor ? `${index + 1}F` : 'OFFICE';
  el('location-mode').textContent = Date.now() < replayUntil ? '기록 다시 보기' : buildingWide ? '건물 전체 보기' : watch ? '자동 관찰' : '선택한 층';
  el('location-project').textContent = buildingWide && !wideFocus ? companyName : floor?.name ?? companyName;
  el('location-detail').textContent = buildingWide ? `${staff().filter(isWorkingAgent).length}명 작업 중 · ${currentFloors.length}개 프로젝트${wideFocus ? ' · 이 층으로 다가가는 중' : ''}` : `${viewName || '연결 대기'} · ${roomActivity}`;
  const currentModels = modelActivity(staff(), events).filter(model => model.workingCount > 0 && bridgeConnected)
    .sort((a, b) => b.workingCount - a.workingCount);
  syncHTML(el('model-signal'), currentModels.slice(0, 3).map(model => `<button data-open="models"><i class="model-dot ${model.workingCount && bridgeConnected ? 'lit' : ''}"></i><span>${escape(model.label)}</span><b>${model.workingCount}</b></button>`).join('') + (currentModels.length > 3 ? `<button data-open="models">+${currentModels.length - 3} 모델</button>` : ''));
  const key = currentCameraKey();
  if (lastCameraKey !== key) { if (!buildingWide) scene?.resetCamera(); setZoomLock(false); lastCameraKey = key; director.roomChanged(); }
  measureSceneInsets();
}
type PortraitSize = 'card' | 'owner' | 'roster' | 'inbox' | 'chip';
function portrait(agent: Pick<Agent, 'id' | 'color'>, size: PortraitSize) {
  return `<span class="portrait portrait-${size}${agent.id === 'boss' ? ' owner-tile' : ''}" aria-hidden="true">${portraitSVG(agent.id, agent.color)}</span>`;
}
function rememberCardOpener() {
  const card = el('employee-card');
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Moving from person to person inside the card keeps the control that first opened it.
  if (!card.hidden && active && card.contains(active)) return;
  cardOpener = active && active !== document.body ? { element: active, selector: focusSelector(active), panel } : null;
}
function restoreCardOpener() {
  const opener = cardOpener; cardOpener = null;
  if (!opener) return;
  const original = opener.element.isConnected ? opener.element : opener.selector ? document.querySelector<HTMLElement>(opener.selector) : null;
  const menu = opener.panel ? document.querySelector<HTMLElement>(`.game-dock [data-open="${CSS.escape(opener.panel)}"]`) : null;
  for (const candidate of [original, menu]) {
    if (!candidate || candidate.closest('[hidden], dialog:not([open])') || candidate.hasAttribute('disabled')) continue;
    candidate.focus({ preventScroll: true });
    if (document.activeElement === candidate) return;
  }
}
function selectAgent(id: string) {
  const agent = agents.find(item => item.id === id);
  if (!agent || (id !== 'boss' && !staff().some(item => item.id === id))) return;
  const cardWasOpen = !el('employee-card').hidden;
  rememberCardOpener();
  setWatch(false);
  if (id !== 'boss') {
    cameraScope = 'floor';
    buildingWide = false; scene?.setBuildingView(false);
    const keepFloorView = selectedProject === projectKey(agent) && selectedSession === ALL_SESSIONS;
    selectedProject = projectKey(agent);
    if (!keepFloorView) selectedSession = sessionKey(agent);
  }
  setZoomLock(false); selectedAgent = id; director.hold(); resetCycle(); closePanel(); renderAll(); scene?.focus(id);
  el('employee-card').hidden = false;
  // A newly opened sheet starts collapsed; moving from person to person keeps the reader's choice.
  if (cardWasOpen) syncCardSheet(); else setCardSheet(false);
  scene?.setCardOpen?.(id);
  el('employee-card-title')?.focus({ preventScroll: true });
}
/** Sheet state lives on the card (layout) and on the game (dock, toast clearance and camera offset). CSS applies it only to narrow or short windows. */
function syncCardSheet() {
  const card = el('employee-card');
  const state = cardSheetExpanded ? 'expanded' : 'collapsed';
  card.dataset.sheet = state;
  if (card.hidden) el('game').removeAttribute('data-card-sheet'); else el('game').dataset.cardSheet = state;
  const toggle = el('card-sheet-toggle');
  toggle.setAttribute('aria-expanded', String(cardSheetExpanded && !card.hidden));
  toggle.setAttribute('aria-label', cardSheetExpanded ? '카드 접기' : '카드 펼쳐 자세히 보기');
}
function setCardSheet(expanded: boolean) { cardSheetExpanded = expanded; syncCardSheet(); }
/** Ends a sheet drag without choosing a state, so a card closed mid-drag reopens at its resting height. */
function clearSheetDrag() {
  const card = el('employee-card');
  if (sheetDrag) try { if (card.hasPointerCapture?.(sheetDrag.pointerId)) card.releasePointerCapture(sheetDrag.pointerId); } catch { /* Already released. */ }
  sheetDrag = null;
  card.classList.remove('sheet-dragging'); card.style.removeProperty('--sheet-drag');
}
function closeEmployee() {
  const wasSelected = Boolean(selectedAgent);
  const card = el('employee-card');
  const focusInCard = document.activeElement instanceof HTMLElement && card.contains(document.activeElement);
  selectedAgent = ''; card.hidden = true; clearSheetDrag(); syncCardSheet();
  if (!wasSelected) return;
  scene?.setCardOpen?.(null);
  scene?.focus(null); setZoomLock(false); queueRender();
  if (focusInCard) restoreCardOpener(); else cardOpener = null;
}
function floorPlaces() {
  const places = new Map<string, { number: number; name: string }>();
  floors().forEach((floor, index) => places.set(floor.id, { number: index + 1, name: floor.name }));
  return places;
}
/** Hierarchy badge from the reported role. Adapters send '개발' as their default classification, so it reads as a team member. */
function rankLabel(agent: Agent) {
  const role = agent.role?.trim() ?? '';
  if (role === '총괄') return '총괄';
  if (role === '개발' || role === '하위 에이전트') return '팀원';
  if (!role || (Object.values(sourceNames) as string[]).includes(role)) return agent.parentAgentId ? '팀원' : '';
  return role;
}
/** Approval requests before errors; within each, the longest-waiting report first. */
function attentionQueue(list = staff()) {
  const waited = (a: Agent, b: Agent) => (Date.parse(a.lastEventAt ?? '') || 0) - (Date.parse(b.lastEventAt ?? '') || 0);
  return [...list.filter(agent => agent.status === 'approval').sort(waited), ...list.filter(agent => agent.status === 'error').sort(waited)];
}
/** Current approval requests in the whole company (errors excluded): the owner card's inbox and the owner's desk tray share it. */
function approvalRequestCount(list = staff()) { return attentionQueue(list).filter(agent => agent.status === 'approval').length; }
function employeeCardMarkup(agent: Agent) {
  const now = Date.now();
  const unconfirmed = Boolean(agent.unconfirmedStatus);
  const live = bridgeConnected && !unconfirmed;
  const style = presentedStatusStyle(agent);
  const label = style.label;
  const place = floorPlaces().get(projectKey(agent));
  const rank = rankLabel(agent);
  const model = agent.modelEvidence === 'reported' && agent.model ? agent.model : '';
  const session = agent.sessionName ?? (agent.sessionId ? `채팅 ${agent.sessionId.slice(0, 8)}` : '');
  const working = isWorkingStatus(agent.status);
  const inTask = working || agent.status === 'approval' || agent.status === 'error';
  const started = live && inTask && agent.taskStartedAt ? Date.parse(agent.taskStartedAt) : NaN;
  const minutes = Number.isFinite(started) ? Math.floor(Math.max(0, now - started) / 60_000) : -1;
  const kind = agent.activityKind && agent.activityKind !== 'general' ? agent.activityKind : undefined;
  const observed = disconnectedAt || agent.lastEventAt;
  const list = staff();
  const parent = agent.parentAgentId ? list.find(item => item.id === agent.parentAgentId) : undefined;
  const children = list.filter(item => item.parentAgentId === agent.id);
  const chip = (member: Agent) => `<button class="team-chip" data-agent="${escape(member.id)}">${portrait(member, 'chip')}<span>${escape(member.name)}</span></button>`;
  // The collapsed bottom sheet shows only the header, so it carries a one-line status summary (hidden elsewhere, and from screen readers).
  const summary = [label, live && isExternalCall(agent) ? EXTERNAL_CALL_LABEL : kind ? activityNames[kind] : ''].filter(Boolean).join(' · ');
  const header = `<header class="badge-head">${portrait(agent, 'card')}<div class="badge-id"><div class="badge-kicker"><span class="badge-source">${escape(sourceNames[agent.source] ?? '')}</span>${rank ? `<span class="rank-badge${rank === '총괄' ? ' lead' : ''}">${escape(rank)}</span>` : ''}</div><h2 id="employee-card-title" tabindex="-1">${escape(agent.name)}</h2>${model ? `<span class="model-chip">${escape(model)}</span>` : ''}<span class="sheet-summary" aria-hidden="true">${statusShapeSVG(style, 12)}<span>${escape(summary)}</span></span></div></header>`;
  const belongs = place || session ? `<div class="badge-place">${place ? `<button class="floor-chip" data-floor="${escape(projectKey(agent))}" aria-label="${place.number}층 ${escape(place.name)} 사무실로 이동">${icon('building')}<span>${place.number}F · ${escape(place.name)}</span>${icon('right')}</button>` : ''}${session ? `<div class="chat-line">${icon('chat')}<span>채팅방</span><strong>${escape(session)}</strong></div>` : ''}</div>` : '';
  const work = [
    bridgeConnected ? '' : `<div class="stale-banner">${icon('unplug')}<span>연결 끊김${observed ? ` · 마지막 관측 ${time(observed)}` : ''}</span></div>`,
    unconfirmed ? `<div class="stale-banner unconfirmed-banner">${icon('clock')}<span>${agent.lastEventAt && Number.isFinite(Date.parse(agent.lastEventAt)) ? '5분 동안 새 활동이 없어요.' : '마지막 활동 시각을 확인할 수 없어요.'} 마지막 상태: ${escape(statusStyleFor(agent.unconfirmedStatus!).label)}<br>현재 실행 여부는 미확인이며, 새 활동을 받으면 다시 표시해요.</span></div>` : '',
    `<h3 class="card-section-title">${live ? '지금 하는 일' : '마지막으로 보인 일'}</h3>`,
    `<div class="status-row"><span class="status-chip" style="--status:${style.color}">${statusShapeSVG(style)}${escape(label)}</span>${minutes >= 0 ? `<span class="elapsed" title="${escape(absoluteTime(agent.taskStartedAt!))} 시작">${icon('clock')}${minutes < 1 ? '1분 미만' : `${minutes}분째`}</span>` : ''}</div>`,
    live && isExternalCall(agent) ? `<div class="work-line">${icon('phone')}<strong>${EXTERNAL_CALL_LABEL}</strong></div>`
      : kind ? `<div class="work-line">${icon(`kind-${kind}`)}<strong>${escape(activityNames[kind])}</strong><span>도구 기준 추정</span></div>` : '',
    live && working && agent.toolName ? `<div class="tool-line"><span>${icon('wrench')}사용 중 도구</span><code class="tool-chip">${escape(agent.toolName)}</code></div>` : '',
    // Observers report only the generic MCP tool name, so the card says the other service is unknown rather than guessing it.
    live && isExternalCall(agent) ? '<p class="call-note">상대 서비스 이름은 받지 않아요</p>' : '',
    live && agent.status === 'approval' ? `<p class="card-note approval">${statusShapeSVG('approval', 13)}<span>원래 앱에서 승인하거나 거절해 주세요</span></p>` : '',
    live && agent.status === 'error' ? `<p class="card-note error">${statusShapeSVG('error', 13)}<span>원래 앱에서 오류를 확인해 주세요</span></p>` : '',
    agent.lastEventAt || agent.task ? `<div class="news-line">${agent.lastEventAt ? `<span title="${escape(absoluteTime(agent.lastEventAt))}">${icon('clock')}최근 소식 · ${live ? relativeTime(agent.lastEventAt, now) : time(agent.lastEventAt)}</span>` : ''}${agent.task ? `<p class="employee-task">${escape(agent.task)}</p>` : ''}</div>` : '',
  ].join('');
  const team = parent || children.length ? `<div class="card-section team-section"><h3 class="card-section-title">팀</h3>${parent ? `<div class="team-row"><span class="team-label">상위</span>${chip(parent)}</div>` : ''}${children.length ? `<div class="team-row"><span class="team-label">하위</span>${children.slice(0, 4).map(chip).join('')}${children.length > 4 ? `<span class="team-more">외 ${children.length - 4}명</span>` : ''}</div>` : ''}</div>` : '';
  return `${header}${belongs}<div class="card-section">${work}</div>${team}<button class="card-link" data-open="communications" data-feed-agent="${escape(agent.id)}">이 직원 소통 기록 ${icon('arrow')}</button>`;
}
function ownerCardMarkup(boss: Agent) {
  const list = staff();
  const places = floorPlaces();
  const working = list.filter(isWorkingAgent).length;
  const inbox = attentionQueue(list);
  const approvals = approvalRequestCount(list);
  const errors = inbox.length - approvals;
  // Old active reports are neither work nor attention; their own cell (omitted at zero) keeps them from reading as 활동 없음.
  const unconfirmed = list.filter(agent => agent.unconfirmedStatus).length;
  const breakdown = [approvals ? `확인 요청 ${approvals}` : '', errors ? `오류 ${errors}` : ''].filter(Boolean).join(' · ');
  const stat = (key: string, mark: string, value: number, unit: string, name: string, detail: string, label: string) =>
    `<button class="company-stat" data-boss-stat="${key}" aria-label="${label}"><span class="stat-value">${mark}<b>${value}</b><small>${unit}</small></span><span class="stat-name">${name}</span>${detail ? `<span class="stat-detail">${detail}</span>` : ''}</button>`;
  // A zero count is left out rather than shown as a cell; nothing at all reads as 활동 없음.
  const stats = [
    working ? stat('working', statusShapeSVG('working'), working, '명', '작업 중', '', `작업 중 ${working}명, 활동 목록 열기`) : '',
    inbox.length ? stat('attention', statusShapeSVG(approvals ? 'approval' : 'error'), inbox.length, '건', '확인 필요', breakdown, `확인 필요 ${inbox.length}건(${breakdown}), 확인할 직원에게 이동`) : '',
    unconfirmed ? stat('unconfirmed', statusShapeSVG(UNCONFIRMED_STYLE), unconfirmed, '명', '상태 미확인', '', `상태 미확인 ${unconfirmed}명, 전체 직원 목록 열기`) : '',
    places.size ? stat('floors', icon('building'), places.size, '개', '프로젝트 층', '', `프로젝트 층 ${places.size}개, 건물 전체 보기`) : '',
  ].join('');
  const basis = bridgeConnected ? '지금 기준' : `연결 끊김${disconnectedAt ? ` · 마지막 관측 ${time(disconnectedAt)}` : ''}`;
  const rows = inbox.slice(0, 3).map(agent => {
    const place = places.get(projectKey(agent));
    return `<button class="inbox-row" data-agent="${escape(agent.id)}">${portrait(agent, 'inbox')}<span class="inbox-copy"><strong>${escape(agent.name)}</strong><span>${statusShapeSVG(agent.status, 11)}<span>${place ? `${place.number}F · ${escape(place.name)} · ` : ''}${escape(statusStyleFor(agent.status).label)}</span></span></span>${icon('right')}</button>`;
  }).join('');
  return `<div class="card-kicker">대표 명함</div><div class="owner-card"><div class="owner-copy"><span class="owner-company">${escape(companySettings.companyName)}</span><div class="owner-name"><h2 id="employee-card-title" tabindex="-1">${escape(companySettings.ownerName)}</h2><span class="owner-badge">대표</span></div><span class="owner-rule" aria-hidden="true"></span></div>${portrait(boss, 'owner')}</div>`
    + `<div class="card-block"><h3 class="card-section-title"><span>회사 현황</span><span>${basis}</span></h3>${stats ? `<div class="company-stats">${stats}</div>` : '<p class="company-quiet">활동 없음</p>'}</div>`
    + (rows ? `<div class="card-block"><h3 class="card-section-title"><span class="inbox-title">${icon('inbox')}결재함</span><span>${inbox.length > 3 ? `총 ${inbox.length}명 중 3명` : `${inbox.length}명`}</span></h3><div class="inbox-list">${rows}</div></div><p class="owner-note">${icon('info')}승인은 원래 앱에서 해요</p>` : '');
}
function runOwnerStat(kind: string) {
  if (kind === 'working') { rosterFilter = 'active'; openPanel('team'); }
  else if (kind === 'attention') { const next = attentionQueue()[0]; if (next) selectAgent(next.id); }
  else if (kind === 'unconfirmed') { rosterFilter = 'all'; openPanel('team'); }
  else if (kind === 'floors') watchBuilding();
}
function renderEmployee() {
  if (!selectedAgent) return;
  const agent = selectedAgent === 'boss' ? agents.find(item => item.id === selectedAgent) : staff().find(item => item.id === selectedAgent);
  if (!agent || (agent.id !== 'boss' && !staff().some(item => item.id === agent.id))) { closeEmployee(); return; }
  el('employee-card').classList.toggle('stale', !bridgeConnected || Boolean(agent.unconfirmedStatus));
  syncHTML(el('employee-detail'), agent.id === 'boss' ? ownerCardMarkup(agent) : employeeCardMarkup(agent));
}
function renderRoster() {
  const groups = floors().map(floor => ({ ...floor, agents: floor.agents.filter(agent => rosterFilter === 'all' || hasVisibleActivity(agent)).sort((a, b) => activityRank(a) - activityRank(b)) }))
    .filter(floor => floor.agents.length).sort((a, b) => activityRank(a.agents[0]!) - activityRank(b.agents[0]!));
  for (const button of document.querySelectorAll<HTMLElement>('[data-roster-filter]')) {
    button.classList.toggle('active', button.dataset.rosterFilter === rosterFilter);
    button.setAttribute('aria-pressed', String(button.dataset.rosterFilter === rosterFilter));
  }
  syncHTML(el('roster'), groups.map(floor => `<div class="roster-floor"><h3>${escape(floor.name)}<span>${floor.agents.length}명</span></h3>${floor.agents.map(agent => `<button class="employee-row" data-agent="${escape(agent.id)}">${portrait(agent, 'roster')}<span class="employee-row-copy"><strong>${agent.parentAgentId ? '↳ ' : ''}${escape(agent.name)}</strong><small>${escape(modelName(agent))}</small></span><span class="employee-status">${statusShapeSVG(presentedStatusStyle(agent), 12)}${escape(statusLabel(agent))}</span>${icon('right')}</button>`).join('')}</div>`).join('') || `<div class="panel-empty">${rosterFilter === 'active' && staff().length ? '현재 활동 중인 직원이 없어요.<br>이전 기록은 전체 직원에서 볼 수 있어요.' : '아직 연결된 직원이 없어요.<br>원래 앱에서 작업을 시작해주세요.'}</div>`);
}
function renderModels() {
  const models = modelActivity(staff(), events).filter(model => model.connectedCount > 0);
  syncHTML(el('model-activity'), models.map(model => {
    const working = staff().filter(agent => modelName(agent) === model.label && isWorkingAgent(agent));
    return `<article class="model-card"><div class="model-card-heading"><span class="model-emblem">${icon('model')}</span><div><h3>${escape(model.label)}</h3><p>${model.connectedCount}명 관측됨 · ${bridgeConnected ? `${model.workingCount}명 작업 중` : '연결 끊김'}</p></div></div><div class="model-counters"><span><b>${model.toolStarts}</b>도구 시작</span><span><b>${model.handoffs}</b>서류 전달</span><span><b>${model.responsesEnded}</b>응답 종료</span></div>${working.slice(0, 3).map(agent => `<button class="model-task" data-agent="${escape(agent.id)}">${statusShapeSVG(agent.status, 12)}<span><strong>${escape(agent.name)}</strong>${escape(agent.task)}</span>${icon('right')}</button>`).join('')}</article>`;
  }).join('') || '<div class="panel-empty">모델 정보가 도착하면 여기에 표시돼요.</div>');
}
function eventMarkup(event: OfficeEvent) {
  const who = event.type === 'user.instruction' ? `${companySettings.ownerName} 사장님` : event.agentName ?? agents.find(a => a.id === event.agentId)?.name ?? event.agentId;
  const toId = event.type === 'user.instruction' ? event.toAgentId ?? event.agentId : event.type === 'message.sent' ? undefined : event.toAgentId;
  const to = toId ? event.toAgentName ?? agents.find(a => a.id === toId)?.name ?? toId : undefined;
  const kind = ['handoff', 'user.instruction', 'message.sent'].includes(event.type) ? 'handoff' : event.type.startsWith('approval.') ? 'approval' : 'work';
  const label = event.type === 'agent.completed' ? '응답 종료' : event.type === 'user.instruction' ? '업무 지시' : event.type === 'message.sent' ? '메시지 송신' : event.type === 'approval.resolved' ? '확인 결과' : '';
  const endpoints = communicationEndpoints(event);
  // Decision 50: a replayed instruction would only open the building view without a flight, so the history offers no replay for it.
  const canReplay = event.type !== 'user.instruction' && endpoints.length > 0 && endpoints.every(id => staff().some(agent => agent.id === id));
  return `<article class="feed-event"><span class="event-icon event-${kind}">${icon(kind === 'handoff' ? 'file' : kind === 'approval' ? 'bell' : 'activity')}</span><div><div class="event-route"><strong>${escape(who)}</strong>${to && kind === 'handoff' ? `<span>→</span><strong>${escape(to)}</strong>` : ''}</div><p>${label ? `${label} · ` : ''}${escape(event.title)}</p><small>${time(event.timestamp)} · ${sourceNames[event.source]}${event.projectName ? ` · ${escape(event.projectName)}` : ''}${event.observation ? ` · ${observationNames[event.observation] ?? '미확인'}` : ''}</small>${canReplay ? `<button class="handoff-replay" data-replay="${escape(event.id)}">비행 다시 보기 ${icon('play')}</button>` : ''}</div></article>`;
}
function syncFeedFilters() {
  document.querySelectorAll<HTMLElement>('[data-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.filter === filter);
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  });
}
function setFeedAgent(id: string) {
  feedAgent = id;
  // One person's history includes their approvals and work updates, not only messages.
  if (id) { filter = 'all'; syncFeedFilters(); }
}
function renderFeed() {
  const person = feedAgent ? agents.find(agent => agent.id === feedAgent) : undefined;
  const list = events.filter(event => (filter === 'all' || (filter === 'handoff' ? ['handoff', 'user.instruction', 'message.sent'].includes(event.type) : event.type.startsWith('approval.')))
    && (!feedAgent || event.agentId === feedAgent || event.toAgentId === feedAgent));
  el('feed-agent-filter').hidden = !feedAgent;
  syncHTML(el('feed-agent-filter'), feedAgent ? `<span>${icon('people')}<span><strong>${escape(person?.name ?? feedAgent)}</strong>의 기록만 보는 중</span></span><button data-feed-clear="true">모든 직원 보기</button>` : '');
  syncHTML(el('feed'), list.slice(0, 100).map(eventMarkup).join('') || `<div class="panel-empty">${feedAgent ? '이 직원의 기록이 아직 없어요.<br>작업 소식이 도착하면 여기에 표시돼요.' : '아직 수신한 기록이 없어요.<br>실제 전달이나 확인 요청이 생기면 여기에 표시돼요.'}</div>`);
}
function renderDispatch() {
  const latest = events[0];
  if (!latest) return;
  const sender = latest.type === 'user.instruction' ? `${companySettings.ownerName} 사장님` : latest.agentName ?? agents.find(agent => agent.id === latest.agentId)?.name ?? latest.agentId;
  const toId = latest.type === 'user.instruction' ? latest.toAgentId ?? latest.agentId : latest.type === 'message.sent' ? undefined : latest.toAgentId;
  const to = toId ? latest.toAgentName ?? agents.find(agent => agent.id === toId)?.name ?? toId : undefined;
  el('dispatch-text').textContent = `${sender}${to ? ` → ${to}` : ''} · ${latest.title}`;
  el('dispatch-time').textContent = time(latest.timestamp);
}
function renderConnection() {
  communicationTime();
  el('connection-label').textContent = bridgeConnected ? '실시간 수신' : '재연결 중';
  el('live-lamp').classList.toggle('connected', bridgeConnected);
  el('game').classList.toggle('disconnected', !bridgeConnected);
  el('connection-notice').hidden = bridgeConnected;
  el('connection-notice').textContent = stateLoaded ? '연결이 끊겨 마지막 상태를 표시하고 있어요. 다시 연결되면 동작이 이어져요.' : '로컬 사무실에 연결하고 있어요…';
  el('bridge-state').innerHTML = `<i class="status-dot ${bridgeConnected ? 'bridge-live' : 'bridge-lost'}"></i><div><strong>${bridgeConnected ? '로컬 수신기 연결됨' : '로컬 수신기 재연결 중'}</strong><small>${stateAvailable ? '최근 직원 상태와 기록을 불러왔어요.' : '다음 작업 소식을 기다려요.'}</small></div>`;
  el('sources-state').innerHTML = (['codex', 'claude'] as const).map(source => {
    const count = staff().filter(agent => agent.source === source).length;
    return `<div class="source-row"><strong>${sourceNames[source]}</strong><span>${count ? `${count}명 관측됨` : '직원 대기'}</span></div>`;
  }).join('');
  scene?.setPaused(paused || !bridgeConnected);
  if (bridgeObserved) scene?.setBridgeConnected?.(bridgeConnected);
  if (!bridgeConnected) resetCycle();
}
function renderPanel() {
  if (panel === 'team') renderRoster();
  if (panel === 'models') renderModels();
  if (panel === 'communications') renderFeed();
  if (panel === 'settings') renderConnection();
  if (panel === 'usage') renderUsage();
}
function renderAll() {
  renderedFreshness = freshnessKey();
  normalizeSelection(); renderNavigation();
  const boss = agents.find(agent => agent.id === 'boss') ?? companyOwner();
  boss.name = companySettings.ownerName;
  // The owner is always at the desk, even before any employee connects (the empty-office notice stays).
  scene?.setAgents([boss, ...sceneStaff(visibleStaff())]);
  // After setAgents, so the tray keeps the company count rather than the shown room's seats; the scene toggles only on change.
  scene?.setApprovalCount?.(approvalRequestCount());
  scene?.setBuildingFloors(floors().map(floor => ({ id: floor.id, name: floor.name, agents: sceneStaff(floor.agents), counts: floor.counts })));
  if (watch && buildingWide && Date.now() >= manualUntil && !zoomLock) scene?.setBuildingView(true, Date.now() - buildingWideStarted > 3500 ? selectedProject : '');
  renderEmployee(); renderDispatch(); renderPanel();
}
function queueRender() {
  if (renderPending || disposed) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; if (!disposed) renderAll(); });
}
const titles: Record<string, [string, string]> = { team: ['우리 직원들', 'THE TEAM'], models: ['모델들의 근무 현황', 'MODEL ACTIVITY'], communications: ['서로 주고받은 소식', 'OFFICE POST'], settings: ['사무실 설정', 'SETTINGS'], usage: ['회사의 에너지', 'SHARED ENERGY'] };
function openPanel(next: string, usageProvider?: string) {
  if (!(next in titles)) return;
  panel = next; closeEmployee();
  if (next === 'settings' && !companyFormDirty && !companySaving) syncCompanyForm();
  for (const key of Object.keys(titles)) el(`${key}-panel`).hidden = key !== next;
  el('panel-title').textContent = titles[next]![0]; el('panel-eyebrow').textContent = titles[next]![1];
  renderPanel();
  const dialog = el<HTMLDialogElement>('office-panel');
  if (!dialog.open) dialog.showModal();
  placeToast();
  if (next === 'usage' && (usageProvider === 'claude' || usageProvider === 'codex')) {
    const section = el(usageSectionId(usageProvider));
    section?.scrollIntoView({ block: 'start' });
    section?.focus({ preventScroll: true });
  }
}
function closePanel() { el<HTMLDialogElement>('office-panel').close(); panel = ''; placeToast(); resetCycle(); }
function syncObservationCamera() {
  const moving = watch && settings.autoRotate;
  const enabled = moving && patrolRooms().length > 0;
  if (observationMotion !== enabled) { scene?.setAutoRotate(enabled); observationMotion = enabled; }
  const button = el<HTMLButtonElement>('orbit');
  button.setAttribute('aria-pressed', String(moving));
  button.disabled = !watch;
  button.title = watch ? `높낮이·줌·방향 움직임 ${moving ? '끄기' : '켜기'}` : '관찰 모드를 켜면 사용할 수 있어요';
}
function applySettings(persist = false) {
  scene?.setReducedMotion(settings.reducedMotion);
  if (!settings.followWork && director.focusedId !== null) {
    scene?.stopFollowing(); director.hold();
    el('director-caption').textContent = '';
  }
  syncObservationCamera();
  scene?.setLabelsVisible(settings.labels);
  scene?.setActivityBubblesVisible(settings.bubbles);
  scene?.setPowerSaving(settings.powerSaving);
  el('game').classList.toggle('reduced-motion', settings.reducedMotion);
  for (const key of ['labels', 'bubbles', 'autoRotate', 'followWork', 'cycle', 'powerSaving', 'reducedMotion'] as const) el<HTMLInputElement>(`setting-${key}`).checked = settings[key];
  el('motion-preference-note').textContent = settings.reducedMotionOverride === null ? '기기의 움직임 설정을 따르고 있어요.' : '이 앱에서 직접 정한 설정을 사용해요.';
  el<HTMLButtonElement>('setting-systemMotion').disabled = settings.reducedMotionOverride === null;
  el<HTMLSelectElement>('setting-cycleSeconds').value = String(settings.cycleSeconds);
  resetCycle();
  if (persist) {
    let saved = false;
    try { saved = saveViewSettings(localStorage, settings); } catch { /* In-memory preferences remain usable. */ }
    el('settings-saved').textContent = saved ? '이 브라우저에 저장했어요.' : '이번 창에 적용했어요. 브라우저 저장 공간을 사용할 수 없어요.';
  }
}
function setWatch(next: boolean) {
  watch = next;
  if (watch) {
    closeEmployee(); closePanel(); manualUntil = 0; setZoomLock(false);
    cameraScope = 'building';
    director.roomChanged(); overviewUntil = Date.now() + 5500;
    alignWatchWithActivity();
    if (cameraScope === 'building' && activeFloorCount() > 1) beginBuildingOverview();
    else if (buildingWide) finishBuildingOverview();
  } else {
    scene?.stopFollowing(); director.hold(); el('director-caption').textContent = '';
  }
  syncObservationCamera();
  el('game').classList.toggle('watching', watch);
  el('watch-overlay').hidden = !watch;
  el('watch-toggle').setAttribute('aria-pressed', String(watch));
  resetCycle();
  renderNavigation();
  if (watch) toast('자동 관찰을 시작했어요. 직접 조작하거나 Esc를 누르면 멈춰요.');
}
function setZoomLock(next: boolean) {
  if (next && !zoomLock) toast('선택한 화면을 유지해요. 다시 둘러보려면 관찰 모드를 켜주세요.');
  zoomLock = next;
  el('game').dataset.zoomLock = String(next);
}
function manualCamera(viewChanged = false) {
  if (viewChanged) setWatch(false);
  manualUntil = Date.now() + 18_000;
  if (buildingWide) buildingWideUntil = Math.max(buildingWideUntil, manualUntil);
  scene?.stopFollowing(); resetCycle(); director.hold(); el('director-caption').textContent = '';
  // Zoom, drag and keyboard input decide the lock; a bare click only postpones automation as before.
  if (viewChanged) setZoomLock(scene?.isZoomedIn() ?? false);
}
function updateDirector() {
  const enabled = watch && settings.followWork && !settings.reducedMotion && !paused && bridgeConnected
    && !panel && !selectedAgent && !document.hidden && !zoomLock;
  if (enabled && director.focusedId && !visibleStaff().some(agent => agent.id === director.focusedId && hasVisibleActivity(agent))) {
    // Release an expired target immediately even when other employees still have live work.
    scene?.focus(null, { cinematic: true, zoom: 1 }); director.roomChanged();
    el('director-caption').textContent = '';
  }
  if (watch && !visibleStaff().some(hasVisibleActivity)) {
    el('director-caption').textContent = '';
    if (enabled && !buildingWide && director.focusedId !== null) {
      scene?.focus(null, { cinematic: true, zoom: 1 }); director.roomChanged();
    }
    return;
  }
  if (buildingWide || Date.now() < overviewUntil) return;
  const shot = director.next(visibleStaff(), Date.now(), enabled);
  if (!shot) return;
  scene?.focus(shot.agentId, { cinematic: true, zoom: shot.zoom });
  const name = agents.find(agent => agent.id === shot.agentId)?.name;
  el('director-caption').textContent = name ? `${name} 따라보는 중` : '';
}
function renderEnergy() {
  syncHTML(el('energy-tanks'), renderEnergyCards(usage, { receiverUnavailable: usageUnavailable }));
  // Usage arriving later changes the usage HUD's height: the camera tools, the floor rail and an open card follow its bottom edge,
  // and beside the floor caption it is a right block of the building shot.
  measureSceneInsets();
}
function renderUsage() {
  syncHTML(el('usage-detail'), renderUsageDetails(usage, { receiverUnavailable: usageUnavailable }));
}
async function refreshUsage() {
  if (usageInFlight || disposed) return;
  usageInFlight = true; usageLastRequested = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/usage', { signal: controller.signal });
    if (!response.ok) throw new Error('usage unavailable');
    usage = parseUsage(await response.json()); usageUnavailable = false;
  } catch { usageUnavailable = true; }
  finally { clearTimeout(timeout); usageInFlight = false; }
  if (disposed) return;
  renderEnergy(); if (panel === 'usage') renderUsage();
}

function tick() {
  const seatTime = communicationTime();
  let seatsExpired = false;
  for (const [id, until] of communicationSeats) if (until <= seatTime) { communicationSeats.delete(id); seatsExpired = true; }
  // A quiet bridge still advances wall time, including after a hidden or paused window resumes.
  if (seatsExpired || freshnessKey() !== renderedFreshness) renderAll();
  el('scene-clock').textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  // Self-heal: a lock only lasts while the camera is actually zoomed past the automatic shot.
  if (zoomLock && scene && !scene.isZoomedIn()) setZoomLock(false);
  const candidates = patrolRooms();
  const cameraEnabled = watch && !settings.reducedMotion && !paused && bridgeConnected && !panel && !selectedAgent && !document.hidden;
  const cycleEnabled = settings.cycle && cameraEnabled && candidates.length > 1;
  const activeFloors = activeFloorCount(candidates);
  if (cameraEnabled && Date.now() >= manualUntil && !zoomLock) alignWatchWithActivity(candidates);
  syncObservationCamera();
  if (cameraScope === 'building' && cameraEnabled && Date.now() >= manualUntil && !zoomLock) {
    if (buildingWide && (activeFloors <= 1 || Date.now() >= buildingWideUntil)) finishBuildingOverview();
    else if (!buildingWide && settings.cycle && activeFloors > 1 && Date.now() >= nextBuildingWideAt) beginBuildingOverview();
    else if (buildingWide) scene?.setBuildingView(true, Date.now() - buildingWideStarted > 3500 ? selectedProject : '');
  }
  const next = buildingDirector.next(staff(), { now: Date.now(), enabled: cycleEnabled && !buildingWide && !zoomLock,
    scope: cameraScope, projectId: selectedProject, current: { projectId: selectedProject, sessionId: selectedSession }, cycleSeconds: settings.cycleSeconds });
  if (next) {
    const changedFloor = selectedProject !== next.projectId;
    pickRoom(next.projectId, next.sessionId, true);
    overviewUntil = Date.now() + next.focusAfterMs;
    el('director-caption').textContent = next.reason === 'activity' ? '새 작업이 시작된 층으로' : next.reason === 'fairness' || next.reason === 'quiet' ? '다른 사무실도 둘러보는 중' : '사무실 전체를 둘러보는 중';
    if (cameraScope === 'building' && changedFloor && activeFloors > 1) beginBuildingOverview();
  }
  playHandoffs();
  updateDirector();
  renderLocationOnly();
  // Relative times and elapsed minutes on an open card follow the clock between events.
  renderEmployee();
  renderEnergy();
  if (panel === 'usage') renderUsage();
  if (!document.hidden && Date.now() - usageLastRequested >= 5000) void refreshUsage();
  el('cycle-status').textContent = !watch ? '선택한 화면 유지 중' : paused ? '동작 일시정지' : settings.reducedMotion ? '동작 줄이기' : zoomLock ? '확대해서 보는 중' : !candidates.length ? '작업 중인 직원을 기다리는 중' : buildingWide ? '여러 층을 둘러보는 중' : cycleEnabled ? `다음 구역까지 ${Math.max(1, Math.ceil((buildingDirector.nextAt - Date.now()) / 1000))}초` : cameraScope === 'floor' ? '선택한 층 관찰 중' : '일하는 직원 관찰 중';
}

function renderLocationOnly() { renderNavigation(); }
function playHandoffs() {
  handoffs.drain({ enabled: !paused && bridgeConnected && !settings.reducedMotion && !document.hidden && Date.now() >= handoffReadyAt
      && (!buildingWide || Date.now() >= buildingWideStarted + 2200),
    ready: (agentId, toId) => !!scene?.hasVisibleAgent(agentId) && (!toId || !!scene?.hasVisibleAgent(toId)),
    play: event => {
      const to = communicationEndpoints(event)[0]!;
      // Decision 50: only an instruction whose recipient was drawn on arrival is queued. If the shown room no longer draws
      // it when it plays, it is recorded only ('drop' leaves the queue with no flight). A drawn recipient refused by the
      // owner plane's limits (false) retries on a later tick.
      let played: boolean;
      if (event.type === 'user.instruction') {
        if (!instructionFlies(event)) return 'drop';
        played = scene?.sendInstructionPlane?.(to, event.id) ?? false;
      } else played = event.type !== 'handoff' ? scene?.sendMessagePlane(to, event.id) ?? false
        : buildingWide ? scene?.sendBuildingPaperPlane(event.agentId, event.toAgentId!, event.id) ?? false
          : scene?.sendPaperPlane(event.agentId, event.toAgentId!, event.id) ?? false;
      if (played) { reserveCommunicationSeats(event, 12_000); markSceneBusy(8000); }
      if (played && buildingWide) buildingWideUntil = Math.max(buildingWideUntil, Date.now() + 10_000);
      return played;
    } });
}
/** Decision 50: an instruction flies only from the owner's desk to a recipient drawn in the shown room. */
function instructionFlies(event: OfficeEvent) {
  const to = communicationEndpoints(event)[0];
  return !buildingWide && !!scene?.sendInstructionPlane && visibleStaff().some(agent => agent.id === to && drawsCharacter(agent));
}
function frameHandoff(entry: OfficeEvent, replay = false) {
  const alreadyWaiting = handoffs.hasPendingHandoff;
  // Decision 50: an instruction is settled on arrival. Its recipient off the shown room, kept without a drawn character,
  // the building view or a scene without owner planes records it in the history only: it is never queued to fly later
  // and reserves no desk. The history offers no replay for an instruction, because a replay opens the building view.
  if (entry.type === 'user.instruction' && (replay || !instructionFlies(entry))) return;
  if (!handoffs.enqueue(entry, Date.now(), { replay })) return;
  reserveCommunicationSeats(entry, 32_000);
  // A local message never requests a camera move. Only an explicit replay may frame it.
  if (entry.type !== 'handoff' && !replay) return;
  if (alreadyWaiting && !replay) return;
  if (!watch && !replay) return;
  if (paused || panel && !replay || selectedAgent || Date.now() < manualUntil || zoomLock && !replay || settings.reducedMotion) return;
  const endpoints = communicationEndpoints(entry);
  const endpointsKnown = endpoints.every(id => staff().some(agent => agent.id === id));
  if (!endpointsKnown) return;
  if (replay) {
    closePanel(); cameraScope = 'building';
    const sender = staff().find(agent => agent.id === endpoints[0])!;
    selectedProject = projectKey(sender); selectedSession = sessionKey(sender);
    renderAll(); replayUntil = Date.now() + 18_000; beginBuildingOverview(); buildingWideUntil = replayUntil;
  }
  else if (endpoints.every(id => projectKey(staff().find(agent => agent.id === id)!) === selectedProject)
    && endpoints.some(id => !scene?.hasVisibleAgent(id))) {
    // The recipient's empty desk remains a real endpoint; framing both chats does not make the recipient active.
    pickRoom(selectedProject, ALL_SESSIONS, true);
    director.hold(Date.now(), 7000); overviewUntil = Date.now() + 7000;
  }
  else if (cameraScope === 'building' && (!scene?.hasVisibleAgent(entry.agentId) || !scene?.hasVisibleAgent(entry.toAgentId!))) {
    nextBuildingWideAt = Math.min(nextBuildingWideAt, Date.now() + 2000);
  } else if (!buildingWide && settings.followWork) {
    scene?.focus(null, { cinematic: true }); director.hold(Date.now(), 7000); overviewUntil = Date.now() + 7000;
  }
  handoffReadyAt = Date.now() + 1800;
}

document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-open], [data-agent], [data-floor], [data-filter], [data-replay], [data-roster-filter], [data-boss-stat], [data-feed-clear]');
  if (!target) return;
  if (target.dataset.open) {
    if (target.dataset.open === 'communications') setFeedAgent(target.dataset.feedAgent ?? '');
    openPanel(target.dataset.open, target.dataset.usageProvider);
  }
  else if (target.dataset.agent) selectAgent(target.dataset.agent);
  else if (target.dataset.floor) pickRoom(target.dataset.floor);
  else if (target.dataset.bossStat) runOwnerStat(target.dataset.bossStat);
  else if (target.dataset.feedClear) { setFeedAgent(''); renderFeed(); }
  else if (target.dataset.rosterFilter) { rosterFilter = target.dataset.rosterFilter === 'all' ? 'all' : 'active'; renderRoster(); }
  else if (target.dataset.replay) {
    const original = events.find(entry => entry.id === target.dataset.replay);
    // The history renders no replay for an instruction (decision 50), so a stale control never opens a flightless replay.
    if (original && original.type !== 'user.instruction') {
      setWatch(false);
      closeEmployee(); manualUntil = 0; setZoomLock(false);
      frameHandoff({ ...original, id: `${original.id}:replay:${++replaySequence}` }, true);
      toast('기록된 소통을 다시 보여드려요. 새로운 메시지를 보내지는 않아요.');
    }
  }
  else if (target.dataset.filter) {
    filter = target.dataset.filter;
    syncFeedFilters(); renderFeed();
  }
});
el('close-panel').addEventListener('click', closePanel);
el('office-panel').addEventListener('close', () => { panel = ''; placeToast(); resetCycle(); });
el('office-panel').addEventListener('click', event => {
  if (event.target !== el('office-panel')) return;
  const rect = el('office-panel').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePanel();
});
el('close-employee').addEventListener('click', closeEmployee);
el('card-sheet-toggle').addEventListener('click', event => {
  // A drag that ends on the grip already chose a state; keyboard activation (detail 0) always toggles.
  if (event.detail !== 0 && Date.now() - sheetDragEndedAt < 400) return;
  setCardSheet(!cardSheetExpanded);
});
el('employee-card').addEventListener('pointerdown', event => {
  const target = event.target as HTMLElement;
  // A floating card has no sheet: its header keeps text selection and the hidden sheet state stays untouched.
  if (!sheetLayout.matches || event.pointerType === 'mouse' && event.button !== 0) return;
  // Drags start on the grip or the card header; other controls keep their taps and the body keeps scrolling.
  if (!target.closest('#card-sheet-toggle, .badge-head, .card-kicker, .owner-card')
    || (target.closest('button, a') && !target.closest('#card-sheet-toggle'))) return;
  sheetDrag = { pointerId: event.pointerId, startY: event.clientY, moved: false };
});
el('employee-card').addEventListener('pointermove', event => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const card = el('employee-card');
  const dy = event.clientY - sheetDrag.startY;
  if (!sheetDrag.moved) {
    if (Math.abs(dy) < 6) return;
    sheetDrag.moved = true; card.classList.add('sheet-dragging');
    try { card.setPointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
  }
  card.style.setProperty('--sheet-drag', `${Math.round(-dy)}px`);
});
const endSheetDrag = (event: PointerEvent) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const { startY, moved } = sheetDrag; clearSheetDrag();
  if (!moved || event.type === 'pointercancel') return;
  sheetDragEndedAt = Date.now();
  const dy = event.clientY - startY;
  if (Math.abs(dy) >= 28) setCardSheet(dy < 0);
};
el('employee-card').addEventListener('pointerup', endSheetDrag);
el('employee-card').addEventListener('pointercancel', endSheetDrag);
el('refresh-usage').addEventListener('click', () => { void refreshUsage(); });
for (const button of document.querySelectorAll('[data-building-cctv]')) button.addEventListener('click', watchBuilding);
window.addEventListener('focus', () => { if (!disposed) { void refreshUsage(); void hydrateCompany(); } });
window.addEventListener('resize', () => { if (!disposed) measureSceneInsets(); });
// The camera tools and the floor rail hang under the usage HUD. Its height also changes outside a render (a late web font, wrapped
// usage text), so a change is measured once per frame.
{
  let pendingEnergyMeasure = 0;
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
    if (pendingEnergyMeasure || disposed) return;
    pendingEnergyMeasure = requestAnimationFrame(() => { pendingEnergyMeasure = 0; if (!disposed) measureSceneInsets(); });
  }).observe(el('energy-hud'));
  document.fonts?.ready.then(() => { if (!disposed) measureSceneInsets(); }, () => {});
}
document.addEventListener('visibilitychange', () => {
  communicationTime();
  if (!document.hidden && !disposed) { queueRender(); void refreshUsage(); }
});
el('session-select').addEventListener('change', () => pickRoom(selectedProject, el<HTMLSelectElement>('session-select').value));
el('project-select').addEventListener('change', () => pickRoom(el<HTMLSelectElement>('project-select').value));
el('find-working').addEventListener('click', () => { const agent = staff().filter(hasVisibleActivity).sort((a, b) => activityRank(a) - activityRank(b))[0]; if (agent) selectAgent(agent.id); });
el('zoom-in').addEventListener('click', () => { scene?.zoom(.3); manualCamera(true); });
el('zoom-out').addEventListener('click', () => { scene?.zoom(-.3); manualCamera(true); });
el('reset-camera').addEventListener('click', () => { closeEmployee(); scene?.resetCamera(); manualCamera(true); });
el('orbit').addEventListener('click', () => { settings.autoRotate = !settings.autoRotate; applySettings(true); });
el('pause').addEventListener('click', () => {
  paused = !paused; communicationTime(); scene?.setPaused(paused || !bridgeConnected);
  el('pause').innerHTML = `${icon(paused ? 'play' : 'pause')} ${paused ? '직원 동작 다시 재생' : '직원 동작 일시정지'}`;
  toast(paused ? '화면 동작을 멈췄어요. AI 작업과 기록 수신은 계속돼요.' : '직원 동작을 다시 재생해요.');
});
for (const key of ['labels', 'bubbles', 'autoRotate', 'followWork', 'cycle', 'powerSaving', 'reducedMotion'] as const) el(`setting-${key}`).addEventListener('change', () => {
  settings[key] = el<HTMLInputElement>(`setting-${key}`).checked;
  if (key === 'reducedMotion') settings.reducedMotionOverride = settings.reducedMotion;
  applySettings(true);
});
el('setting-systemMotion').addEventListener('click', () => {
  settings.reducedMotionOverride = null; settings.reducedMotion = motionPreference.matches; applySettings(true);
});
const onMotionPreferenceChange = () => {
  if (settings.reducedMotionOverride !== null || disposed) return;
  settings.reducedMotion = motionPreference.matches; applySettings();
};
motionPreference.addEventListener('change', onMotionPreferenceChange);
el('setting-cycleSeconds').addEventListener('change', () => { settings.cycleSeconds = Number(el<HTMLSelectElement>('setting-cycleSeconds').value); applySettings(true); });
el('watch-toggle').addEventListener('click', () => setWatch(!watch));
el('exit-watch').addEventListener('click', () => setWatch(false));
// A press on the office may be a click on the owner, whose reaction or five-click spin must not be cut by the first crane.
el('scene').addEventListener('pointerdown', () => { markSceneBusy(3000); manualCamera(); });
el('scene').addEventListener('pointermove', event => { if (event.buttons) manualCamera(true); });
el('scene').addEventListener('wheel', () => manualCamera(true), { passive: true });
// In the building view PageUp/PageDown step the focus floor and the scene glides there. The page takes that key before the canvas
// (capture), so the manual hold it records cannot stop the glide the scene starts next. Other keys keep the bubbling order, where
// the scene has already applied the zoom the lock reads.
let floorStepEvent: Event | null = null;
el('scene').addEventListener('keydown', event => {
  if (!buildingWide || (event.key !== 'PageUp' && event.key !== 'PageDown')) return;
  floorStepEvent = event; manualCamera(true);
}, true);
el('scene').addEventListener('keydown', event => { if (event !== floorStepEvent && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','PageUp','PageDown','+','-','=','_'].includes(event.key)) manualCamera(true); });
el('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await el('game').requestFullscreen(); }
  catch { toast('이 브라우저에서는 전체 화면 버튼을 사용할 수 없어요. 창을 직접 확대해주세요.'); }
});
document.addEventListener('fullscreenchange', () => el('fullscreen').setAttribute('aria-label', document.fullscreenElement ? '전체 화면 나가기' : '전체 화면'));
el('open-window').addEventListener('click', () => {
  const opened = window.open('/', 'agent-office-watch', 'popup,width=960,height=720');
  if (!opened) toast('독립 창을 열지 못했어요. 이 사이트의 팝업을 허용해주세요.');
  else { opened.opener = null; closePanel(); toast('관찰용 독립 창을 열었어요. 옆 모니터로 옮겨주세요.'); }
});
document.addEventListener('keydown', event => {
  if ((event.target as HTMLElement).closest('input,select,textarea,[contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape') { if (panel) return; if (selectedAgent) closeEmployee(); else if (watch) setWatch(false); }
  else if (event.key.toLowerCase() === 'c' && !panel && !event.repeat) { event.preventDefault(); setWatch(!watch); }
});

function ingest(entry: OfficeEvent, animate = true) {
  if (!entry.id || !entry.agentId || !entry.title || !['codex', 'claude', 'manual'].includes(entry.source) || seen.has(entry.id)) return;
  seen.add(entry.id); if (seen.size > 5000) seen.delete(seen.values().next().value!);
  // The wall router blinks for each accepted event; the scene limits the rate and skips it with reduced motion.
  scene?.pulseRouter?.();
  updateAgentState(agents, entry);
  if (entry.type === 'agent.model') { queueRender(); return; }
  events.unshift(entry); events = events.slice(0, 500);
  if (animate && communicationEndpoints(entry).length) frameHandoff(entry);
  // A handoff reports a recipient, but does not prove the recipient has connected or started working.
  if (animate && !document.hidden) {
    renderAll();
    playHandoffs();
    if (entry.type === 'approval.requested') { scene?.requestApproval(entry.agentId); toast(`${entry.agentName ?? '직원'}의 확인 요청이 도착했어요.`); }
    // The owner files a finished visit (up to 1.5s wait and a 1.6s gesture), which the first crane must not cut.
    if (entry.type === 'approval.resolved') { scene?.resolveApproval(entry.agentId); markSceneBusy(3200); }
  } else queueRender();
}
const stream = new EventSource('/api/events');
const pending: OfficeEvent[] = [];
let hasConnected = false;
let hydrationRunning = false;
stream.onopen = () => {
  const reconnecting = hasConnected;
  hasConnected = true;
  bridgeObserved = true;
  bridgeConnected = true;
  renderConnection(); queueRender();
  // SSE replay is bounded. Refresh lifecycle snapshots after a gap so departed workers cannot linger.
  if ((reconnecting || !stateAvailable) && !hydrationRunning) void hydrate();
};
stream.onerror = () => {
  if (bridgeConnected) disconnectedAt = new Date(Date.now()).toISOString();
  bridgeObserved = true; bridgeConnected = false; renderConnection(); queueRender();
};
stream.onmessage = event => {
  try { const entry = JSON.parse(event.data) as OfficeEvent; if (!stateLoaded) { pending.push(entry); if (pending.length > 1000) pending.shift(); } else ingest(entry); }
  catch { toast('읽을 수 없는 작업 소식을 건너뛰었어요.'); }
};
async function hydrate() {
  if (hydrationRunning) return;
  hydrationRunning = true;
  stateLoaded = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch('/api/state', { signal: controller.signal });
    if (!response.ok) throw new Error('state unavailable');
    const state = await response.json() as { agents?: OfficeEvent[]; events?: OfficeEvent[] };
    agents = [companyOwner()];
    for (const snapshot of state.agents ?? []) if (snapshot.source !== 'demo') updateAgentState(agents, snapshot);
    for (const event of state.events ?? []) {
      if (event.type === 'agent.model') continue;
      if (event.source === 'demo' || seen.has(event.id)) continue;
      seen.add(event.id); events.push(event);
    }
    if (!state.agents) for (const event of events) updateAgentState(agents, event);
    events = events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 500);
    stateAvailable = true;
  } catch { /* Current SSE events remain available when saved state cannot be loaded. */ }
  finally { clearTimeout(timeout); }
  stateLoaded = true;
  hydrationRunning = false;
  for (const entry of pending.splice(0)) ingest(entry, false);
  renderAll(); renderConnection();
  if (!hasShownBuilding && cameraScope === 'building' && staff().length) beginBuildingOverview();
}
function syncCompanyForm() {
  el<HTMLInputElement>('company-name').value = companySettings.companyName;
  el<HTMLInputElement>('owner-name').value = companySettings.ownerName;
}
function applyCompanySettings(value: CompanySettings) {
  companySettings = value; companyName = value.companyName;
  renderCompanySettings(document, value);
  scene?.setOwnerNames?.({ companyName: value.companyName, ownerName: value.ownerName });
  document.title = `${companyName} · Cubirumi`;
  renderAll();
}
async function hydrateCompany() {
  const revision = companyRevision;
  const loadId = ++companyLoadId;
  const loaded = await loadCompanySettings(fetch, companySettings);
  if (disposed || companySaving || revision !== companyRevision || loadId !== companyLoadId) return;
  applyCompanySettings(loaded);
  if (!companyFormDirty) syncCompanyForm();
}
el('company-form').addEventListener('input', () => {
  companyFormDirty = true;
  el('company-save-status').textContent = '';
});
el('company-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (companySaving) return;
  const patch: Partial<CompanySettings> = {};
  for (const [key, id] of [['companyName', 'company-name'], ['ownerName', 'owner-name']] as const) {
    const value = el<HTMLInputElement>(id).value;
    if (value !== companySettings[key]) patch[key] = value;
  }
  if (!Object.keys(patch).length) { el('company-save-status').textContent = '이미 저장된 이름이에요.'; return; }
  companySaving = true;
  companyRevision++;
  const controls = ['company-name', 'owner-name', 'save-company'].map(id => el<HTMLInputElement | HTMLButtonElement>(id));
  for (const control of controls) control.disabled = true;
  const status = el('company-save-status');
  status.textContent = '저장 중…'; status.classList.remove('error');
  try {
    const saved = await saveCompanySettings(patch);
    if (disposed) return;
    applyCompanySettings(saved); syncCompanyForm(); companyFormDirty = false;
    status.textContent = '명찰과 간판에 반영했어요.';
  } catch (error) {
    if (!disposed) {
      status.textContent = error instanceof Error && !(error instanceof TypeError) && error.name !== 'AbortError'
        ? error.message : '로컬 사무실에 연결하지 못했어요. 다시 시도해주세요.';
      status.classList.add('error');
    }
  } finally {
    companySaving = false;
    for (const control of controls) control.disabled = false;
  }
});
applySettings(); setWatch(watch); renderAll(); renderConnection(); void hydrate(); void hydrateCompany(); void refreshUsage(); tick();
const clockTimer = setInterval(tick, 1000);
window.addEventListener('pagehide', () => { disposed = true; motionPreference.removeEventListener('change', onMotionPreferenceChange); stream.close(); handoffs.clear(); clearInterval(clockTimer); clearTimeout(toastTimer); scene?.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
