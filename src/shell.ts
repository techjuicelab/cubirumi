import { msg } from './i18n.ts';

const paths: Record<string, string> = {
  office: '<path d="M4 21V5l8-3 8 3v16M2 21h20M9 21v-5h6v5M8 8h.01M16 8h.01M8 12h.01M16 12h.01M12 7h.01"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>',
  model: '<rect x="5" y="5" width="14" height="14" rx="4"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m14 0h4M1 15h4m14 0h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  camera: '<path d="M15 10l6-4v12l-6-4"/><rect x="2" y="5" width="13" height="14" rx="3"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  orbit: '<ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-30 12 12)"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m10 6 6 6-6 6"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  plug: '<path d="M7 3v5m10-5v5M5 8h14v3a7 7 0 0 1-14 0V8Zm7 10v4"/>',
  check: '<path d="m5 12 4 4L19 6"/>', bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', window: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 8h18M7 5.5h.01M10 5.5h.01"/>',
};
// Card glyphs are drawn on a 16-unit grid and scaled into the shared 24-unit icon frame.
const compactPaths: Record<string, string> = {
  building: '<path d="M2.5 13.5 L13.5 13.5 M3.5 13.5 L3.5 4 L9 2.5 L9 13.5 M9 6.5 L12.5 7.5 L12.5 13.5 M5.5 6 L7 5.6 M5.5 8.6 L7 8.2 M5.5 11.2 L7 10.8"/>',
  chat: '<path d="M2.5 4.2 C2.5 3.2 3.2 2.5 4.2 2.5 L11.8 2.5 C12.8 2.5 13.5 3.2 13.5 4.2 L13.5 9.3 C13.5 10.3 12.8 11 11.8 11 L7 11 L4.2 13.5 L4.2 11 C3.2 11 2.5 10.3 2.5 9.3 Z"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5 L8 8 L10.2 9.3"/>',
  wrench: '<path d="M10.2 2.6 A3.3 3.3 0 0 0 7.1 7 L2.8 11.3 A1.3 1.3 0 0 0 4.7 13.2 L9 8.9 A3.3 3.3 0 0 0 13.4 5.8 L11.4 7.8 L9.6 7.3 L8.2 6.4 L10.2 2.6 Z"/>',
  phone: '<rect x="4.5" y="1.8" width="7" height="12.4" rx="2"/><path d="M7 11.8 L9 11.8"/>',
  info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3 L8 11"/><circle cx="8" cy="5" r=".6"/>',
  inbox: '<path d="M2.5 9 L4.5 3 L11.5 3 L13.5 9 L13.5 13 L2.5 13 Z M2.5 9 L6 9 L6.8 10.6 L9.2 10.6 L10 9 L13.5 9"/>',
  unplug: '<path d="M6 2.5 L6 5.5 M10 2.5 L10 5.5 M4 5.5 L12 5.5 L12 8 A4 4 0 0 1 4 8 Z M8 12 L8 14"/><path d="M2 2 L14 14"/>',
  'kind-coding': '<path d="M5.5 4.5 L2 8 L5.5 11.5 M10.5 4.5 L14 8 L10.5 11.5 M9 3 L7 13"/>',
  'kind-documents': '<path d="M4 2.5 L9.5 2.5 L12 5 L12 13.5 L4 13.5 Z M9.5 2.5 L9.5 5 L12 5 M6 8 L10 8 M6 10.8 L9 10.8"/>',
  'kind-research': '<circle cx="7" cy="7" r="4.2"/><path d="M10.1 10.1 L13.5 13.5"/>',
  'kind-testing': '<path d="M6 2.5 L6 6.5 L2.9 12.2 C2.5 13 3 13.5 3.8 13.5 L12.2 13.5 C13 13.5 13.5 13 13.1 12.2 L10 6.5 L10 2.5 M5 2.5 L11 2.5 M4.6 9.8 L11.4 9.8"/>',
  'kind-reviewing': '<path d="M1.8 8 C3.6 4.8 5.6 3.5 8 3.5 C10.4 3.5 12.4 4.8 14.2 8 C12.4 11.2 10.4 12.5 8 12.5 C5.6 12.5 3.6 11.2 1.8 8 Z"/><circle cx="8" cy="8" r="2"/>',
  'kind-planning': '<path d="M7 4 L13.5 4 M7 8 L13.5 8 M7 12 L13.5 12 M2.5 4 L3.5 5 L5 3 M2.5 8 L3.5 9 L5 7 M2.5 12 L3.5 13 L5 11"/>',
  'kind-design': '<path d="M3 13 L3.8 9.8 L10.6 3 A1.4 1.4 0 0 1 12.6 3 L13 3.4 A1.4 1.4 0 0 1 13 5.4 L6.2 12.2 Z M9.4 4.2 L11.8 6.6"/>',
  'kind-delivery': '<path d="M13.5 2.5 L2.5 7 L7 9 L9 13.5 Z M7 9 L13.5 2.5"/>',
  'kind-shipping': '<path d="M2.5 5 L8 2.5 L13.5 5 L13.5 11 L8 13.5 L2.5 11 Z M2.5 5 L8 7.5 L13.5 5 M8 7.5 L8 13.5"/>',
};
export function icon(name: string) {
  const compact = compactPaths[name];
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${compact ? `<g transform="scale(1.5)" stroke-width="1.1">${compact}</g>` : paths[name] ?? paths.file}</svg>`;
}

// Only product copy is marked for relocalization; live data and editable names stay untouched.
const messages = {
  liveOffice: ['Cubirumi live office', 'Cubirumi 실시간 사무실'],
  office3d: ['3D office', '3D 사무실'],
  currentProject: ['Project being observed', '현재 관찰 중인 프로젝트'],
  building: ['Building overview', '건물 전체 보기'],
  myCompany: ['My Company', '나의 회사'],
  waitingConnection: ['Waiting for a connection', '연결을 기다리는 중'],
  connecting: ['Connecting', '연결 중'],
  fullscreen: ['Full screen', '전체 화면'],
  sharedEnergyLabel: ['Shared account energy', '계정 공용 에너지'],
  sharedEnergy: ['Shared energy', '공용 에너지'],
  projectFloors: ['Project office floors', '프로젝트 사무실 층'],
  activePlaces: ['Find activity', '활동 있는 곳'],
  findActivity: ['Go to an employee working or needing attention', '작업 또는 확인이 필요한 직원에게 이동'],
  chooseProject: ['Choose a project', '프로젝트 선택'],
  currentOffice: ['Current office', '현재 사무실'],
  waitingStaff: ['An office waiting for its team', '출근을 기다리는 사무실'],
  chatWorkspace: ['Chat workspace', '채팅 작업구역'],
  noEmployees: ['No employees have arrived yet', '아직 출근한 직원이 없어요'],
  emptyDescription: ['Start working in Codex or Claude Code. Connected projects and employees will appear here.', 'Codex 또는 Claude Code에서 일을 시작하면 연결된 프로젝트와 직원이 여기에 나타나요.'],
  connectionStatus: ['View connection status', '연결 상태 보기'],
  officeCamera: ['Office camera', '사무실 카메라'],
  zoomIn: ['Zoom in', '확대'],
  zoomInShortcut: ['Zoom in (+)', '확대 (+)'],
  zoomOut: ['Zoom out', '축소'],
  zoomOutShortcut: ['Zoom out (−)', '축소 (−)'],
  cameraMovement: ['Observation camera movement', '관찰 카메라 움직임'],
  cameraMovementHint: ['Observe from different heights, distances, and angles', '높낮이·줌·방향을 바꾸며 관찰'],
  defaultView: ['Default view', '기본 시점'],
  defaultViewShortcut: ['Default view (Home)', '기본 시점 (Home)'],
  sceneHint: ['Drag to rotate 360° · Scroll to zoom · Click an employee to get closer', '드래그로 360° 회전 · 휠로 확대 · 직원을 눌러 가까이'],
  latestNews: ['Latest news', '최근 소식'],
  waitingNews: ['Waiting for the next update', '직원들의 다음 소식을 기다리는 중'],
  officeMenu: ['Office menu', '사무실 메뉴'],
  activity: ['Activity', '활동'],
  modelActivity: ['Models', '모델 활동'],
  autoObserve: ['Auto observe', '자동 관찰'],
  communications: ['History', '소통 기록'],
  settings: ['Settings', '설정'],
  observing: ['Observing the office', '사무실 관찰 중'],
  stopObserveBuilding: ['Stop auto observation and show the building', '자동 관찰을 멈추고 건물 전체 보기'],
  exitObserve: ['End observation', '관찰 종료'],
  expandCard: ['Expand the card for details', '카드 펼쳐 자세히 보기'],
  closeEmployee: ['Close employee details', '직원 정보 닫기'],
  swipeCard: ['Swipe up for more details', '위로 밀면 자세히 보여요'],
  closePanel: ['Close panel', '패널 닫기'],
  refreshUsage: ['Refresh received usage', '수신 내용 새로고침'],
  usagePolling: ['Received usage is checked every 5 seconds. Each service may report new limits at a different time.', '수신된 사용량은 5초마다 확인해요. 각 서비스가 새 한도를 보내는 시각은 다를 수 있어요.'],
  usageShared: ['Employees using the same account share this energy.', '같은 계정을 쓰는 직원들이 함께 사용하는 에너지예요.'],
  usageMeaning: ['Based on official usage limits. This is not an individual employee’s stamina or ability score. Energy is not shown as recharged until new figures arrive, even after the reset time.', '공식 사용 한도를 바탕으로 표시합니다. 직원 개인의 체력·능력 점수가 아니며, 회복 시각이 지나도 새 수치가 도착하기 전에는 충전됐다고 표시하지 않아요.'],
  rosterFilter: ['Employee list filter', '직원 목록 필터'],
  activeStaff: ['Active', '활동 중'],
  allStaff: ['All employees', '전체 직원'],
  rosterHelp: ['Active includes employees working, awaiting approval, or reporting errors. All employees also includes idle employees. Click an employee to visit their desk.', '활동 중에는 작업·승인·오류 상태를 표시해요. 전체 직원에는 대기 중인 직원도 포함돼요. 직원을 누르면 자리로 이동해요.'],
  modelQuestion: ['Which models are doing what?', '어떤 모델이 무슨 일을 하고 있을까요?'],
  modelMeaning: ['Based on connected models and retained recent records. Tool use, handoff, and response completion counts do not measure performance or time spent.', '현재 연결된 모델과 보관된 최근 기록 기준입니다. 도구 사용·전달·응답 종료 횟수는 업무 성과나 실제 소요 시간을 뜻하지 않아요.'],
  communicationsFilter: ['Communications filter', '소통 기록 필터'],
  messages: ['Messages & instructions', '메시지·지시'],
  approvals: ['Approval requests', '확인 요청'],
  allRecords: ['All records', '모든 기록'],
  communicationsHelp: ['Real messages become paper planes flying between computers. Use “Replay flight” in the records to see a missed handoff again.', '실제로 주고받은 소식이 종이비행기가 되어 컴퓨터 사이를 날아가요. 기록의 ‘비행 다시 보기’로 놓친 전달을 다시 볼 수 있어요.'],
  communicationsMeaning: ['Handoffs fly between computers; ordinary messages fly around the sender’s computer. Give instructions and approvals in the original app.', '전달은 컴퓨터 사이로, 일반 메시지는 해당 컴퓨터 주변으로 날아가요. 업무 지시와 승인은 원래 앱에서 해주세요.'],
  companyHeading: ['Your company & owner', '우리 회사와 사장님'],
  ownerDefault: ['Me', '나'],
  ownerOffice: ['’s little office', ' 사장님의 작은 사무실'],
  companyName: ['Company name', '회사 이름'],
  ownerName: ['Owner name', '사장님 이름'],
  saveNames: ['Save names', '이름 저장'],
  namesSaved: ['Names are saved on this computer and appear on the company sign and owner’s name badge.', '이름은 이 컴퓨터에 저장돼요. 회사 간판과 사장님 명찰에 함께 반영됩니다.'],
  languageHeading: ['Language', '언어'],
  displayLanguage: ['Display language', '화면 언어'],
  languageHelp: ['Choose the language for this office and the macOS app menus.', '사무실 화면과 macOS 앱 메뉴의 언어를 선택해요.'],
  appearance: ['Appearance', '이 화면의 모습'],
  workBubbles: ['Employee activity bubbles', '직원 업무 말풍선'],
  workBubblesHint: ['Show work, approvals, and errors; hide idle bubbles', '작업·승인·오류 표시 · 대기 말풍선은 숨김'],
  nameBadges: ['Employee name badges', '직원 명찰'],
  nameBadgesHint: ['Show names and models for working or selected employees', '작업 중이거나 선택한 직원의 이름과 모델 표시'],
  livingCamera: ['Moving observation camera', '살아 있는 관찰 카메라'],
  livingCameraHint: ['Slowly explore different heights, distances, and angles', '높이·거리·시점을 천천히 바꾸며 둘러보기'],
  reduceMotion: ['Reduce motion', '움직임 줄이기'],
  reduceMotionHint: ['Reduce employee animation and automatic camera movement', '직원 동작과 자동 카메라 이동 줄이기'],
  followSystem: ['Use device settings', '기기 설정 따르기'],
  powerSaving: ['Power saving', '절전 화면'],
  powerSavingHint: ['For long sessions on a side monitor · up to 30 fps', '옆 모니터에 오래 켜둘 때 · 최대 30fps'],
  hideQuietFloors: ['Hide quiet floors', '오래 쉰 층 숨기기'],
  hideQuietFloorsHint: ['Hide project floors with no updates for this long; they return as soon as news arrives', '이 시간 동안 새 소식이 없는 프로젝트 층은 건물에서 빼요 · 소식이 오면 바로 돌아와요'],
  minutes30: ['30 minutes', '30분'],
  hour1: ['1 hour', '1시간'],
  hours3: ['3 hours', '3시간'],
  hours6: ['6 hours', '6시간'],
  hours12: ['12 hours', '12시간'],
  day1: ['1 day', '하루'],
  days3: ['3 days', '3일'],
  days7: ['7 days', '7일'],
  neverHide: ['Never hide', '숨기지 않음'],
  maximumFloors: ['Maximum building floors', '건물 최대 층수'],
  maximumFloorsHint: ['Show floors with the most recent updates first. Floors with work, approval requests, or errors always stay visible.', '층이 더 많으면 최근에 소식이 온 층부터 보여줘요 · 작업·확인 요청·오류가 있는 층은 항상 보여요'],
  floors4: ['4 floors', '4층'],
  floors6: ['6 floors', '6층'],
  floors8: ['8 floors', '8층'],
  floors10: ['10 floors', '10층'],
  floors12: ['12 floors', '12층'],
  noLimit: ['No limit', '제한 없음'],
  autoObserveHelp: ['Automatic camera movement, work tracking, and tours start only when you click Auto observe or press C. Interacting with the view ends observation. Switching to another app keeps your chosen view.', '자동 관찰 버튼이나 C를 눌렀을 때만 자동 회전·업무 추적·순회가 시작돼요. 직접 화면을 조작하면 종료되고, 다른 앱으로 이동해도 선택한 화면을 유지해요.'],
  followWork: ['Follow working employees', '일하는 직원 따라보기'],
  followWorkHint: ['Slowly approach active desks and look around at other employees', '일하는 자리로 천천히 다가가며 다른 직원도 둘러보기'],
  officeTour: ['Automatic office tour', '사무실 자동 순회'],
  officeTourHint: ['Move from the building overview to busy floors and employees', '건물 전경에서 바쁜 층과 직원에게 다가가기'],
  dwellTime: ['Time in each area', '한 구역에 머무는 시간'],
  seconds15: ['15 seconds', '15초'],
  seconds25: ['25 seconds', '25초'],
  seconds45: ['45 seconds', '45초'],
  seconds60: ['60 seconds', '60초'],
  pauseAnimation: ['Pause employee animation', '직원 동작 일시정지'],
  animationOnly: ['Only the on-screen animation changes. AI work continues.', '화면의 동작만 바뀌며 AI 작업은 계속 진행돼요.'],
  appWindow: ['Keep an app window open', '앱처럼 띄워두기'],
  independentWindow: ['Open a small independent window', '작은 독립 창으로 열기'],
  independentWindowHelp: ['The macOS Cubirumi app opens without an address bar. Use the Window menu to keep it on top. In a browser, use the button above to open an independent window.', 'macOS용 Cubirumi 앱은 주소창 없이 열리며, 창 메뉴에서 항상 위에 표시할 수 있어요. 브라우저에서는 위 버튼으로 독립 창을 열 수 있어요.'],
  connectedApps: ['Connected apps', '연결된 앱'],
  connectionHelp: ['Connection & camera controls', '연결 방법과 화면 조작'],
  connectCodex: ['Start the existing Agent Office plugin and local receiver for Codex, then begin work in the original app. Claude Code connects through its local plugin.', 'Codex의 기존 Agent Office 플러그인과 로컬 수신기를 실행한 뒤, 원래 앱에서 작업을 시작해주세요. Claude Code는 로컬 플러그인을 통해 연결합니다.'],
  receiverHelp: ['The downloaded app starts its receiver automatically. To start the receiver from source, run', '다운로드 앱은 수신기를 함께 시작합니다. 소스에서 수신기를 직접 시작하려면 프로젝트 폴더에서'],
  receiverCommand: ['in the project folder.', '를 실행하세요.'],
  rotate: ['Rotate', '회전'],
  rotateHelp: ['Drag · arrow keys', '드래그 · 방향키'],
  zoom: ['Zoom', '확대·축소'],
  zoomHelp: ['Scroll · pinch · + / −', '휠 · 두 손가락 오므리기 · + / −'],
  pan: ['Pan', '화면 이동'],
  panHelp: ['Right-drag · Shift + drag · two-finger pan', '우클릭 드래그 · Shift + 드래그 · 두 손가락 이동'],
  observationShortcut: ['C · Esc to exit', 'C · Esc로 나오기'],
  privacyHelp: ['This view does not show raw prompts, source code, or the AI’s internal reasoning.', '프롬프트·코드 원문과 AI의 내부 사고를 보여주는 화면은 아닙니다.'],
  settingsSaved: ['Display settings are saved in this browser.', '화면 설정은 이 브라우저에 저장돼요.'],
} as const;
type CopyKey = keyof typeof messages;
function copy(key: CopyKey): string { return msg(messages[key][0], messages[key][1]); }
function escapeMarkup(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function text(key: CopyKey): string { return `<span data-i18n="${key}">${escapeMarkup(copy(key))}</span>`; }
function attribute(name: 'aria-label' | 'title', key: CopyKey): string { return `${name}="${escapeMarkup(copy(key))}" data-i18n-${name}="${key}"`; }
function option(value: number, key: CopyKey): string { return `<option value="${value}" data-i18n="${key}">${escapeMarkup(copy(key))}</option>`; }

export function localizeShell(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n as CopyKey;
    if (Object.hasOwn(messages, key)) node.textContent = copy(key);
  }
  for (const name of ['aria-label', 'title'] as const) {
    for (const node of root.querySelectorAll<HTMLElement>(`[data-i18n-${name}]`)) {
      const key = node.getAttribute(`data-i18n-${name}`) as CopyKey;
      if (Object.hasOwn(messages, key)) node.setAttribute(name, copy(key));
    }
  }
}

export function renderShell(): string { return `
<main class="game" id="game" ${attribute('aria-label', 'liveOffice')}>
  <div class="world-wash" aria-hidden="true"></div>
  <div id="scene" class="scene" ${attribute('aria-label', 'office3d')}></div>
  <aside class="scene-location" ${attribute('aria-label', 'currentProject')}>
    <div class="location-kicker"><b id="location-floor">OFFICE</b><span id="location-mode">${copy('building')}</span></div>
    <strong id="location-project">${copy('myCompany')}</strong><span id="location-detail">${copy('waitingConnection')}</span>
  </aside>
  <header class="hud top-hud">
    <div class="company-plaque"><span class="company-mark">${icon('office')}</span><div><span class="micro-label">AGENT OFFICE</span><strong data-company-name>${copy('myCompany')}</strong></div></div>
    <div class="broadcast"><span class="live-lamp" id="live-lamp"></span><span id="connection-label">${copy('connecting')}</span><span class="broadcast-divider"></span><time id="scene-clock"></time><button id="fullscreen" class="icon-button" aria-label="${copy('fullscreen')}">${icon('expand')}</button></div>
  </header>
  <aside class="energy-hud" id="energy-hud" ${attribute('aria-label', 'sharedEnergyLabel')}><span class="micro-label">${text('sharedEnergy')}</span><div id="energy-tanks"></div></aside>
  <aside class="hud floor-rail" ${attribute('aria-label', 'projectFloors')}><div class="rail-cap">FLOORS <span id="floor-count">0</span></div><div id="floor-list" class="floor-list"></div><button id="building-cctv" class="building-cctv" ${attribute('aria-label', 'building')} ${attribute('title', 'building')} data-building-cctv aria-pressed="true">${icon('camera')}${text('building')}</button><button id="find-working" class="find-working" ${attribute('aria-label', 'activePlaces')} ${attribute('title', 'findActivity')}>${icon('activity')}${text('activePlaces')}</button></aside>
  <select id="project-select" class="hud project-select" ${attribute('aria-label', 'chooseProject')}></select>
  <section class="hud room-caption" ${attribute('aria-label', 'currentOffice')}><span class="floor-number" id="floor-number">—</span><div class="room-caption-copy"><h1 id="room-title">${copy('waitingStaff')}</h1><div class="room-meta"><select id="session-select" ${attribute('aria-label', 'chatWorkspace')}></select><span id="room-activity"></span><span id="room-count"></span></div></div></section>
  <div class="stage-note" id="connection-notice" role="status" hidden></div>
  <div class="empty-office" id="empty-office" hidden><span class="empty-symbol">${icon('plug')}</span><h2>${text('noEmployees')}</h2><p>${text('emptyDescription')}</p><button class="primary-button" data-open="settings">${text('connectionStatus')} ${icon('arrow')}</button></div>
  <div class="hud camera-tools" ${attribute('aria-label', 'officeCamera')}><button class="icon-button" id="zoom-in" ${attribute('aria-label', 'zoomIn')} ${attribute('title', 'zoomInShortcut')}>${icon('plus')}</button><button class="icon-button" id="zoom-out" ${attribute('aria-label', 'zoomOut')} ${attribute('title', 'zoomOutShortcut')}>${icon('minus')}</button><span></span><button class="icon-button" id="orbit" ${attribute('aria-label', 'cameraMovement')} aria-pressed="false" ${attribute('title', 'cameraMovementHint')}>${icon('orbit')}</button><button class="icon-button" id="reset-camera" ${attribute('aria-label', 'defaultView')} ${attribute('title', 'defaultViewShortcut')}>${icon('reset')}</button></div>
  <div class="hud scene-hint" data-i18n="sceneHint">${copy('sceneHint')}</div>
  <div class="hud bottom-hud">
    <button class="dispatch-strip" id="latest-dispatch" data-open="communications"><span class="dispatch-icon">${icon('file')}</span><span><small>${text('latestNews')}</small><strong id="dispatch-text">${copy('waitingNews')}</strong></span><time id="dispatch-time"></time>${icon('right')}</button>
    <nav class="game-dock" ${attribute('aria-label', 'officeMenu')}><button data-open="team" class="dock-button">${icon('people')}${text('activity')}<b id="active-count">0</b></button><button data-open="models" class="dock-button">${icon('model')}${text('modelActivity')}</button><button id="watch-toggle" class="watch-button" aria-pressed="false">${icon('camera')}${text('autoObserve')}<kbd>C</kbd></button><button data-open="communications" class="dock-button">${icon('file')}${text('communications')}</button><button data-open="settings" class="dock-button">${icon('settings')}${text('settings')}</button></nav>
    <div class="model-signal" id="model-signal"></div>
  </div>
  <div class="watch-overlay" id="watch-overlay" hidden><span class="watch-light"></span><span id="watch-caption">${copy('observing')}</span><button id="camera-scope" class="camera-scope" data-building-cctv aria-pressed="true" ${attribute('title', 'stopObserveBuilding')}>${text('building')}</button><span id="cycle-status"></span><span id="director-caption"></span><button id="exit-watch">${text('exitObserve')} <kbd>Esc</kbd></button></div>
  <aside class="employee-card" id="employee-card" hidden role="region" aria-labelledby="employee-card-title" data-sheet="collapsed"><button id="card-sheet-toggle" class="card-sheet-toggle" type="button" aria-controls="employee-detail" aria-expanded="false" aria-label="${copy('expandCard')}"></button><button id="close-employee" class="icon-button close-employee" ${attribute('aria-label', 'closeEmployee')}>${icon('close')}</button><div id="employee-detail"></div><p class="sheet-hint" aria-hidden="true">${text('swipeCard')}</p></aside>
</main>
<dialog id="office-panel" class="office-panel" aria-labelledby="panel-title"><header class="panel-heading"><div><span class="micro-label" id="panel-eyebrow">OFFICE</span><h2 id="panel-title"></h2></div><button id="close-panel" class="icon-button" ${attribute('aria-label', 'closePanel')}>${icon('close')}</button></header>
  <section id="usage-panel" hidden><button id="refresh-usage" class="secondary-button">${icon('reset')} ${text('refreshUsage')}</button><p class="panel-footnote">${text('usagePolling')}</p><p class="panel-lead">${text('usageShared')}</p><div id="usage-detail"></div><p class="panel-footnote">${text('usageMeaning')}</p></section>
  <section id="team-panel" hidden><div class="feed-filters roster-filters" role="group" ${attribute('aria-label', 'rosterFilter')}><button data-roster-filter="active" class="active" aria-pressed="true">${text('activeStaff')} <b id="roster-active-count">0</b></button><button data-roster-filter="all" aria-pressed="false">${text('allStaff')} <b id="staff-count">0</b></button></div><p class="panel-lead" id="roster-summary"></p><p class="panel-footnote">${text('rosterHelp')}</p><div id="roster" class="roster"></div></section>
  <section id="models-panel" hidden><p class="panel-lead">${text('modelQuestion')}</p><div id="model-activity"></div><p class="panel-footnote">${text('modelMeaning')}</p></section>
  <section id="communications-panel" hidden><div class="feed-filters" role="group" ${attribute('aria-label', 'communicationsFilter')}><button data-filter="handoff" class="active" aria-pressed="true">${text('messages')}</button><button data-filter="approval" aria-pressed="false">${text('approvals')}</button><button data-filter="all" aria-pressed="false">${text('allRecords')}</button></div><div id="feed-agent-filter" class="feed-agent-filter" hidden></div><p class="panel-lead">${text('communicationsHelp')}</p><div id="feed" class="event-feed"></div><p class="panel-footnote">${text('communicationsMeaning')}</p></section>
  <section id="settings-panel" hidden>
    <form id="company-form" class="settings-group company-form">
      <div class="company-form-heading"><span class="company-mark">${icon('office')}</span><div><h3>${text('companyHeading')}</h3><p><span data-owner-name>${copy('ownerDefault')}</span>${text('ownerOffice')}</p></div></div>
      <label class="name-field" for="company-name"><span>${text('companyName')}</span><input id="company-name" name="companyName" type="text" required autocomplete="organization" aria-describedby="company-settings-note"></label>
      <label class="name-field" for="owner-name"><span>${text('ownerName')}</span><input id="owner-name" name="ownerName" type="text" required autocomplete="nickname" aria-describedby="company-settings-note"></label>
      <div class="company-form-actions"><button type="submit" class="primary-button" id="save-company">${icon('check')} ${text('saveNames')}</button><span id="company-save-status" role="status" aria-live="polite"></span></div>
      <p class="panel-footnote" id="company-settings-note">${text('namesSaved')}</p>
    </form>
    <div class="settings-group"><h3>${text('languageHeading')}</h3><label class="setting-row"><span><strong>${text('displayLanguage')}</strong><small>${text('languageHelp')}</small></span><select id="setting-language"><option value="en" lang="en">English</option><option value="ko" lang="ko">한국어</option></select></label></div>
    <div class="settings-group"><h3>${text('appearance')}</h3><label class="setting-row"><span><strong>${text('workBubbles')}</strong><small>${text('workBubblesHint')}</small></span><input type="checkbox" id="setting-bubbles" role="switch"></label><label class="setting-row"><span><strong>${text('nameBadges')}</strong><small>${text('nameBadgesHint')}</small></span><input type="checkbox" id="setting-labels" role="switch"></label><label class="setting-row"><span><strong>${text('livingCamera')}</strong><small>${text('livingCameraHint')}</small></span><input type="checkbox" id="setting-autoRotate" role="switch"></label><label class="setting-row"><span><strong>${text('reduceMotion')}</strong><small>${text('reduceMotionHint')}</small></span><input type="checkbox" id="setting-reducedMotion" role="switch" aria-describedby="motion-preference-note"></label><div class="motion-preference"><small id="motion-preference-note"></small><button id="setting-systemMotion" class="text-button" type="button">${text('followSystem')}</button></div><label class="setting-row"><span><strong>${text('powerSaving')}</strong><small>${text('powerSavingHint')}</small></span><input type="checkbox" id="setting-powerSaving" role="switch"></label><label class="setting-row"><span><strong>${text('hideQuietFloors')}</strong><small>${text('hideQuietFloorsHint')}</small></span><select id="setting-dormantFloorMinutes" aria-describedby="dormant-floors-note">${option(30, 'minutes30')}${option(60, 'hour1')}${option(180, 'hours3')}${option(360, 'hours6')}${option(720, 'hours12')}${option(1440, 'day1')}${option(4320, 'days3')}${option(10080, 'days7')}${option(0, 'neverHide')}</select></label><label class="setting-row"><span><strong>${text('maximumFloors')}</strong><small>${text('maximumFloorsHint')}</small></span><select id="setting-maxFloors" aria-describedby="dormant-floors-note">${option(4, 'floors4')}${option(6, 'floors6')}${option(8, 'floors8')}${option(10, 'floors10')}${option(12, 'floors12')}${option(0, 'noLimit')}</select></label><p class="panel-footnote" id="dormant-floors-note"></p></div>
    <div class="settings-group"><h3>${text('autoObserve')}</h3><p class="panel-footnote">${text('autoObserveHelp')}</p><label class="setting-row"><span><strong>${text('followWork')}</strong><small>${text('followWorkHint')}</small></span><input type="checkbox" id="setting-followWork" role="switch"></label><label class="setting-row"><span><strong>${text('officeTour')}</strong><small>${text('officeTourHint')}</small></span><input type="checkbox" id="setting-cycle" role="switch"></label><label class="setting-row"><span><strong>${text('dwellTime')}</strong></span><select id="setting-cycleSeconds">${option(15, 'seconds15')}${option(25, 'seconds25')}${option(45, 'seconds45')}${option(60, 'seconds60')}</select></label><button class="secondary-button" id="pause">${icon('pause')} ${copy('pauseAnimation')}</button><p class="panel-footnote">${text('animationOnly')}</p></div>
    <div class="settings-group"><h3>${text('appWindow')}</h3><button class="secondary-button" id="open-window">${icon('window')} ${text('independentWindow')}</button><p class="panel-footnote">${text('independentWindowHelp')}</p></div>
    <div class="settings-group"><h3>${text('connectedApps')}</h3><div id="bridge-state" class="bridge-state"></div><div id="sources-state"></div><details class="connection-help"><summary>${text('connectionHelp')}</summary><p>${text('connectCodex')}</p><p>${text('receiverHelp')} <code>npm start</code> ${text('receiverCommand')}</p><dl><dt>${text('rotate')}</dt><dd>${text('rotateHelp')}</dd><dt>${text('zoom')}</dt><dd>${text('zoomHelp')}</dd><dt>${text('pan')}</dt><dd>${text('panHelp')}</dd><dt>${text('defaultView')}</dt><dd>Home</dd><dt>${text('autoObserve')}</dt><dd>${text('observationShortcut')}</dd></dl><p>${text('privacyHelp')}</p></details></div>
    <p class="settings-saved" id="settings-saved" role="status">${copy('settingsSaved')}</p>
  </section>
</dialog><div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true" hidden></div>`; }

// Kept for integrations that still consume a single initial shell string.
export const shell = renderShell();
