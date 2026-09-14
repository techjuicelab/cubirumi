import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CameraPointers, clampZoom, orbitAngles } from './office-camera.ts';
import { MAX_OFFICE_AGENTS, officeBounds, seatPosition, routeBetweenSeats, routeToApproval, approvalSpot } from './office-layout.ts';
import { activityMessage, activityBubbleWidth, placeActivityBubbles, ACTIVITY_BUBBLE_HEIGHT } from './activity-bubble.ts';
import type { ActivityMessage, BubbleCandidate } from './activity-bubble.ts';
import { BuildingOverview, floorKeyStep, PLATE_HALF_HEIGHT, type BuildingFloorInput } from './building-overview.ts';
import { createCinematicMotionState, stepCinematicMotion, holdCinematicMotion, CINEMATIC_PROFILES } from './cinematic-motion.ts';
import { actionDelay, foldedPaperPlane, idleYawnDelay, paperPlaneCurve, paperPlaneMessageCurve, paperPlaneScale, paperPlaneTrail, updatePaperPlaneTrail, YAWN_DURATION, yawnStrength,
  estimateTextWidth, fitNameLabel, ROUTER_FLASH_SECONDS, ROUTER_LED_COLORS, ROUTER_PULSE_GAP_SECONDS, ROUTER_RECONNECT_SECONDS, routerReconnectFlash,
  WINDOW_LIGHT, windowLightAt, INSTRUCTION_GAP_SECONDS, INSTRUCTION_TARGET_COOLDOWN_SECONDS, OWNER_ACTION_RANK, OWNER_ACTION_SECONDS,
  OWNER_FINISH_WAIT_SECONDS, OWNER_SURVEY_SECONDS, registerOwnerClick, type OwnerActionKind,
  CALL_ENTER_SECONDS, CALL_TURN_RADIANS, CALL_WAVE_BARS, CALL_WAVE_STEP_SECONDS, callWaveLevel } from './office-effects.ts';
import { DeskWork } from './desk-work.ts';
import { WorkMarkers } from './work-markers.ts';
import { isWorkingStatus } from './work-activity.ts';
import type { ActivityKind } from './protocol.ts';
import { appearanceFor, appearanceKey, type Appearance } from './appearance.ts';
import { STATUS_STYLE, isExternalCall, statusStyleFor } from './status-style.ts';

type AgentInput = { id: string; status: string; task?: string; taskId?: string; toolName?: string; activityKind?: ActivityKind; color?: string; name?: string; model?: string; modelEvidence?: string; showCharacter?: boolean };
/** HUD blocks around the stage, in CSS pixels from each edge. */
export type HudInsets = { top: number; right: number; bottom: number; left: number };
/**
 * Insets reported for the building shot. `beside` repeats them with the floor caption at the top left counted as a left block
 * under the higher HUD edge above it (decision 53); the scene fits the building there only where that is clearly better.
 */
export type BuildingHudInsets = HudInsets & { beside?: HudInsets | null };
/**
 * Building shot: pixels kept clear inside the HUD insets (a share of the free span, between the minimum and the maximum, so a
 * small free area is still filled), and the largest share of the window the insets may take together. Where the HUD blocks take
 * more (a short window, such as 1280x500), the insets shrink to that share on purpose: the model then reaches a little under the
 * HUD edges instead of shrinking into an illegible strip. The side insets beside the floor caption never shrink: that shot is only
 * chosen where the model fits the column right of the caption (decision 53), so it never reaches under the caption instead.
 */
const FRAME_PADDING = 10, FRAME_PADDING_MIN = 5, FRAME_PADDING_SHARE = .025, FRAME_MAX_VERTICAL_INSET = .7, FRAME_MAX_HORIZONTAL_INSET = .6;
/** Capacity of the reused fit arrays: the building's silhouette points plus the ground-floor plate. */
const FRAME_POINT_LIMIT = 24;
/**
 * The automatic building shot keeps one scale through the ambient drift. It uses the largest of these shares of the drift's turn,
 * tilt and pan for which the fits of all sampled drift poses differ by at most `FRAME_DRIFT_SPREAD`, at the smallest of those fits,
 * so desks and people never breathe in size; low, wide buildings, whose fit changes most with the angle, drift least.
 */
const FRAME_DRIFT_SHARES = [1, .6, .4, .25, .15, .08, 0] as const;
const FRAME_DRIFT_SPREAD = 1.05;
/** Drift poses sampled per share, as fractions of the building profile's turn and tilt. */
const FRAME_DRIFT_YAW_STEPS = [-1, -.5, 0, .5, 1] as const, FRAME_DRIFT_TILT_STEPS = [-1, 0, 1] as const;
/**
 * Fit inputs the drift share and the caption decision depend on: size, insets below and beside the caption (with a presence flag),
 * base pose, point count, stand-in radius, plate flag and point coordinates.
 */
const FRAME_KEY_LENGTH = 16 + FRAME_POINT_LIMIT * 3;
/**
 * Decision 53, as [enter, stay] pairs so a boundary never switches the shot back and forth: the building fits beside the floor
 * caption only while the free height below the caption is under `FRAME_BESIDE_BAND` px (a short window), the fit beside it is at
 * least `FRAME_BESIDE_GAIN` times larger, and the column right of the caption's edge holds that larger model and its nameplate
 * column with `FRAME_BESIDE_COLUMN` px to spare.
 */
const FRAME_BESIDE_BAND = [280, 300] as const, FRAME_BESIDE_COLUMN = [8, 0] as const, FRAME_BESIDE_GAIN = [1.25, 1.1] as const;
/** Zoom of a floor approach inside the building view, lowered where the whole model would leave the screen. */
const BUILDING_FOCUS_ZOOM = 1.22;
type AgentFigure = {
  id: string;
  group: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftKnee: THREE.Group;
  rightKnee: THREE.Group;
  screen: THREE.Mesh;
  halo: THREE.Mesh;
  signal: THREE.Group;
  paper: THREE.Group;
  origin: THREE.Vector3;
  shirt: THREE.MeshStandardMaterial;
  status: string;
  phase: number;
  seat: number;
  homeYaw: number;
  label: HTMLDivElement;
  activity: ActivityMessage;
  bubble: HTMLDivElement;
  bubbleContent: HTMLSpanElement;
  bubbleWidth: number;
  compactBubbleWidth: number;
  nameWidth: number;
  detail?: THREE.Group;
  approvalStamp?: THREE.Group;
  yawnStartedAt: number | null;
  nextYawnAt: number;
  yawnCycle: number;
  yawnMouth?: THREE.Mesh;
  smile?: THREE.Mesh;
  eyes?: THREE.Mesh[];
  // Detail pass: every field below is optional so partial figures (tests, older fixtures) keep working.
  trim?: THREE.MeshStandardMaterial;
  cuff?: THREE.MeshStandardMaterial;
  torso?: THREE.Mesh;
  brows?: THREE.Mesh[];
  mouthLine?: THREE.Mesh;
  mouthOpen?: THREE.Mesh;
  mouthWave?: THREE.Group;
  sweat?: THREE.Mesh;
  ponytail?: THREE.Group;
  watchFace?: THREE.MeshStandardMaterial;
  handMug?: THREE.Group;
  steam?: THREE.Mesh[];
  lampGlow?: THREE.Mesh;
  led?: THREE.Mesh;
  hasWatch?: boolean;
  expression?: string;
  expressionSince?: number;
  blinkStartedAt?: number | null;
  nextBlinkAt?: number;
  reachStartedAt?: number | null;
  nextReachAt?: number;
  flipStartedAt?: number | null;
  nextFlipAt?: number;
  tapStartedAt?: number | null;
  nextTapAt?: number;
  sipStartedAt?: number | null;
  nextSipAt?: number;
  glanceStartedAt?: number | null;
  nextGlanceAt?: number;
  actionCycle?: number;
  doneAt?: number;
  bowUntil?: number;
  nodUntil?: number;
  lookYaw?: number | null;
  catchUntil?: number;
  pushUntil?: number;
  previousMouth?: string;
  activityKind?: ActivityKind;
  deskWork?: DeskWork;
  look?: FigureLook;
  // Owner-only moments (seat 0): a sheet filed into the tray, an occasional look over the office, a smoothed turn toward a visitor.
  handSheet?: THREE.Group;
  surveyStartedAt?: number | null;
  nextSurveyAt?: number;
  attention?: number;
  attentionYaw?: number;
  // External (MCP) calls, employees only: a phone lies on the desk and rises to the ear; the lit screen is built on the first call.
  phone?: THREE.Group;
  phoneScreen?: THREE.Group;
  phoneBars?: THREE.Mesh[];
  onCall?: boolean;
  callBlend?: number;
  callWaveStep?: number;
};
/** Parts that belong to a person rather than a seat; a reused figure swaps them in place when its identity changes. */
type FigureLook = {
  agentId: string; key: string;
  parts: THREE.Object3D[]; skin: THREE.Mesh[]; hair: THREE.Mesh[]; shoes: THREE.Mesh[];
  // Trousers and soles recolor with the look; the owner's jeans hems and seams show only while the owner's look is worn.
  pants?: THREE.Mesh[]; soles?: THREE.Mesh[]; bossOnly?: THREE.Object3D[];
};
type PaperFlight = {
  fromId: string; toId: string; sender: AgentFigure; recipient: AgentFigure;
  curve: THREE.Curve<THREE.Vector3>; plane: THREE.Mesh; arrival: THREE.Mesh; trail: THREE.Line;
  duration: number; elapsed: number; lane: number;
};
type ApprovalVisit = { figure: AgentFigure; route: THREE.Vector3[]; leg: number; progress: number; stage: 'out' | 'waiting' | 'return'; slot: number };
type Delivery = {
  courier: AgentFigure;
  recipient: AgentFigure;
  route: THREE.Vector3[];
  leg: number;
  progress: number;
  stage: 'out' | 'handoff' | 'return';
  timer: number;
};

const PALETTE = {
  cream: '#eef5fa', floor: '#e5ebed', line: '#d8e0e5', wood: '#d4b08a',
  sage: '#9dbdaa', mint: '#b9d9bf', dark: '#31495e', lavender: '#b8acd8',
  yellow: '#eed58e', peach: '#e7af96', blue: '#8fbbd2', white: '#fffdf5',
};
/** The owner's high-back chair is dark walnut leather (seat 0 only), so the navy turtleneck keeps a clear outline. */
const OWNER_CHAIR = { seat: '#8a6a50', back: '#7a5c45' } as const;
/** The owner's minimal look below the turtleneck: jeans with a rolled hem and yellow seam, white sneakers, thin navy frames. */
const OWNER_LOOK = { jeans: '#7188a8', hem: '#7c96b9', stitch: PALETTE.yellow, sneaker: PALETTE.white, sole: PALETTE.line, frame: PALETTE.dark } as const;
const EMPLOYEE_LOOK = { pants: '#55675b', shoe: '#f7f6e9', sole: '#c1cabc', frame: '#5b6455' } as const;
/** A logo-free rounded phone: navy body with darker sides, a lighter rear camera module, a cream call screen, green icon and blue waveform. */
const PHONE = {
  width: .17, height: .34, depth: .028, corner: .046,
  body: PALETTE.dark, side: '#283d50', module: '#465b6e', glass: '#283d50', screen: PALETTE.cream, call: '#83b491', wave: '#7188a8', flash: PALETTE.yellow,
} as const;
/** The phone lies right of the mouse on the beveled desktop (seated figure coordinates, before any body swivel). */
const PHONE_DESK = { x: -.9, y: 1.26 + .085 * .45 + PHONE.depth / 2, z: .56, yaw: .2 } as const;
/** The mouse arm's pivot and angles with the hand at the ear, and the phone there with its screen toward the cheek. */
const CALL_ARM = { x: -.38, y: 1.58, z: .05, rx: -2.46, rz: -.66 } as const;
const PHONE_EAR_POSITION = new THREE.Vector3(-.49, 1.9, .03);
const PHONE_EAR_QUATERNION = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, -.6, -.8), new THREE.Vector3(0, .8, -.6), new THREE.Vector3(1, 0, 0)));
const phoneDeskPosition = new THREE.Vector3();
const phoneDeskEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const phoneDeskQuaternion = new THREE.Quaternion();
const SIGNAL_STATUSES = new Set(['working', 'thinking', 'reviewing', 'approval', 'error']);
const smoothstep01 = (value: number): number => {
  const k = THREE.MathUtils.clamp(value, 0, 1);
  return k * k * (3 - 2 * k);
};
/** Settings-driven lettering: the office sign '{company} 대표실' and the desk nameplate '{owner} 대표'. */
const LETTERING = {
  sign: { width: 768, height: 116, font: 50, padding: 40, background: '#91aba9', color: '#f5f9fb', suffix: '대표실' },
  nameplate: { width: 384, height: 84, font: 42, padding: 16, background: PALETTE.dark, color: PALETTE.white, suffix: '대표' },
} as const;
const windowScratch = new THREE.Color();
const shadeScratch = new THREE.Color();
/** Same hue, a little darker or lighter, measured in sRGB so a 10% step looks like 10%. Never a new palette color. */
function shadeColor(target: THREE.Color, source: THREE.Color, factor: number): THREE.Color {
  return target.copy(source).convertLinearToSRGB().multiplyScalar(factor).convertSRGBToLinear();
}
function shadeHex(hex: string, factor: number): string {
  return `#${shadeColor(shadeScratch, new THREE.Color(hex), factor).getHexString()}`;
}


/** A local, asset-free miniature office. The host owns agent data and event semantics. */
export class OfficeScene {
  private readonly container: HTMLElement;
  private readonly onSelect: (id: string) => void;
  private readonly onFloor?: (id: string) => void;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-13, 13, 10, -10, .1, 150);
  private readonly world = new THREE.Group();
  private readonly effects = new THREE.Group();
  private workLayer = new THREE.Group();
  private readonly backWall = new THREE.Group();
  private wallDecor: THREE.Group | null = null;
  // Built once (the back wall plane never moves), kept out of batching and hidden together with the back wall.
  private ownerSign: THREE.Mesh | null = null;
  private readonly leftWall = new THREE.Group();
  private readonly roomShell = new THREE.Group();
  private readonly fixtureRows = new Map<number, THREE.Group>();
  private readonly geometryCache = new Map<string, THREE.BufferGeometry>();
  private readonly approvalRequests = new Set<string>();
  private readonly approvalVisits = new Map<string, ApprovalVisit>();
  private bounds = officeBounds(1);
  private zoomGoal = 1;
  // The zoom the office chose for the current shot; a user zoom beyond it pauses automatic camera changes.
  private automaticZoom = 1;
  private cinematic = false;
  private cinematicElapsed = 0;
  // Length of the running cinematic; unset means the standard 2.6s shot (the building intro sets its own).
  private cinematicSeconds?: number;
  private cinematicStartZoom = 1;
  private framing = 0;
  private framingGoal = 0;
  private cinematicStartFraming = 0;
  private readonly cinematicStartTarget = new THREE.Vector3();
  private farFigures: THREE.InstancedMesh | null = null;
  private farDesks: THREE.InstancedMesh | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private stampPending = false;
  private stampUntil = 0;
  private clockHands: { hour: THREE.Mesh; minute: THREE.Mesh } | null = null;
  private clockMinute = -1;
  // Only the sign and the desk nameplate own canvas textures; both are redrawn when their settings name changes.
  private ownerNames = { companyName: '', ownerName: '' };
  private ownerNamesApplied = false;
  private signLettering: THREE.Mesh | null = null;
  private nameplateLettering: THREE.Mesh | null = null;
  // Live pieces on the batched owner desk (approval sheets, nameplate lettering) stay out of static merging.
  private ownerDeskLive: THREE.Group | null = null;
  private approvalPile: { sheets: THREE.Mesh[]; clip: THREE.Mesh; count: number } | null = null;
  // Company-wide approval request count from the host; unset keeps the tray on this room's seated requests.
  private approvalCount?: number;
  // Window panes and the floor light patch share dedicated materials that follow the local time once a minute.
  private windowGlass: THREE.MeshStandardMaterial | null = null;
  private windowPatch: THREE.MeshBasicMaterial | null = null;
  private windowMinute = -1;
  // The back-wall router LED shows only a connection state the host reported; it is neutral until then.
  private routerLed: THREE.Mesh | null = null;
  private routerLedMaterial: THREE.MeshStandardMaterial | null = null;
  private bridgeConnected: boolean | null = null;
  private routerPulseAt = -Infinity;
  private routerReconnectAt = -Infinity;
  private routerLedKey = '';
  // The owner's single running moment and the requests that may start one; see updateOwnerPose.
  private ownerAction: { kind: OwnerActionKind; startedAt: number; duration: number } | null = null;
  private ownerFinishRequestedAt: number | null = null;
  private ownerClicks: number[] = [];
  private instructionLog: { lastAt: number; targets: Map<string, number> } = { lastAt: -Infinity, targets: new Map() };
  // The employee whose card is open drops head-top markers at detail LOD; the bubble and the selection ring stay.
  private cardOpenId: string | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly cameraPointers = new CameraPointers();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly figures: AgentFigure[] = [];
  private readonly agentSeats = new Map<string, number>();
  private readonly deliveries: Delivery[] = [];
  private readonly queued: Array<{ from: string; to: string }> = [];
  private readonly paperFlights: PaperFlight[] = [];
  private readonly seenPlaneEvents = new Set<string>();
  private readonly observer: ResizeObserver;
  private animationId = 0;
  private hiddenFramePending = false;
  private elapsed = 0;
  private paused = false;
  private suspended = false;
  private speed = 1;
  private reducedMotion = false;
  private disposed = false;
  private focusId: string | null = null;
  private yaw = .61;
  private elevation = .81;
  private cameraZoom = 1;
  private following = false;
  private autoRotate = false;
  private labelsVisible = true;
  private activityBubblesVisible = true;
  private readonly visibleBubbles = new Set<string>();
  private powerSaving = false;
  private autoRotateAfter = 0;
  private manualProjectionBase: number | undefined;
  private lastFrameTime: number | null = null;
  private readonly cameraTarget = new THREE.Vector3(0, .3, .15);
  private readonly targetGoal = new THREE.Vector3(0, .3, .15);
  private building?: BuildingOverview;
  private buildingView = false;
  private buildingFocus = '';
  /** Bottom HUD height in CSS pixels (`--hud-clearance`), read on real resizes; the building shot's bottom inset until the page reports its HUD. */
  private hudClearancePx = 0;
  /** HUD blocks around the stage reported by the page; the building shot fits the whole model between them. */
  private hudInsets: HudInsets | null = null;
  /** The same HUD with the floor caption counted as a left block under the higher HUD edge (decision 53); null when not reported. */
  private hudInsetsBeside: HudInsets | null = null;
  /** True while the building shot fits beside the floor caption; kept between fits as the hysteresis state of that decision. */
  private frameBeside = false;
  /** Floor the automatic building shot last aimed at ('' for the whole building), refitted when the caption decision changes; null before any. */
  private approachId: string | null = null;
  /** Reused per fit: the insets below and beside the caption after the share limits. */
  private frameAreaBelow?: HudInsets;
  private frameAreaBeside?: HudInsets;
  /** Base pose the building fit uses; after a manual orbit the previous pose stays, so a later zoom does not shift the image. */
  private frameYaw: number | undefined;
  private frameElevation = 0;
  /** Undrifted pose behind the fit pose, the share of the drift the building shot uses around it and the scale shared by those poses. */
  private frameBaseYaw = 0;
  private frameBaseElevation = 0;
  private frameDriftShare?: number;
  private frameDriftScale = 0;
  /** Last fit inputs of the drift share; the share and its scale are recomputed only when one changes. */
  private frameKey?: Float64Array;
  private frameKeyValid = false;
  /** Reused pixel extents of the last measured pose: min x, max x, min y, max y around the image centre. */
  private frameExtent?: Float64Array;
  /** Last building fit: projection half-height at zoom 1 and the view offset in CSS pixels. */
  private frameBase = 0;
  private frameOffsetX = 0;
  private frameOffsetY = 0;
  /** HUD insets the last building fit used (after the share limits); nameplates stay left of its right edge. */
  private frameArea?: HudInsets;
  /** Reused per fit: silhouette points in screen axes (world units) and their vertical pixel margins. */
  private frameU?: Float64Array;
  private frameV?: Float64Array;
  private framePad?: Float64Array;
  private motion = createCinematicMotionState();
  private workMarkers?: WorkMarkers;
  private detailedWorkIds = new Set<string>();
  private lastWorkDetailAt = -Infinity;
  private lastWorkDetailKey = '';
  private readonly workAnchor = new THREE.Vector3();

  constructor(container: HTMLElement, onSelect: (id: string) => void, onFloor: (id: string) => void = () => {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onFloor = onFloor;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor('#dce9f2', 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.domElement.setAttribute('aria-label', '3D 사무실. 드래그와 방향키로 회전, 휠과 더하기·빼기로 확대, 우클릭 또는 Shift 드래그로 이동, Home으로 처음 보기. 직원을 클릭하면 자세히 볼 수 있습니다.');
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.style.touchAction = 'none';
    container.append(this.renderer.domElement);
    this.scene.add(this.world, this.effects, this.workLayer);
    this.workMarkers = new WorkMarkers();
    this.workLayer.add(this.workMarkers.group);
    // Rail clicks, plate first clicks and rail keys focus a floor inside the building; the camera follows that floor.
    this.building = new BuildingOverview(container, onFloor, projectId => this.glideToBuildingFloor(projectId));
    this.scene.add(this.building.group);
    this.buildLighting();
    this.buildRoom();
    this.ensureCapacity(1);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.renderer.domElement.addEventListener('pointercancel', this.pointerCancel);
    this.renderer.domElement.addEventListener('lostpointercapture', this.pointerCancel);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.renderer.domElement.addEventListener('keydown', this.onKeyDown);
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu);
    this.renderer.domElement.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.animate();
  }

  setAgents(agents: AgentInput[]): void {
    this.lastWorkDetailAt = -Infinity;
    const previousStatuses = new Map(this.figures.filter(figure => figure.group.visible).map(figure => [figure.id, figure.status]));
    const allAgents = [...new Map(agents.map(agent => [agent.id, agent])).values()];
    const uniqueAgents = [...allAgents.filter(agent => agent.id === 'boss'),
      ...allAgents.filter(agent => agent.id !== 'boss').slice(0, MAX_OFFICE_AGENTS)];
    const capacity = uniqueAgents.filter(agent => agent.id !== 'boss').length + 1;
    const nextSeats = new Map<string, number>();
    const claimed = new Set<number>([0]);
    for (const agent of uniqueAgents) {
      if (agent.id === 'boss') { nextSeats.set(agent.id, 0); continue; }
      const previous = this.agentSeats.get(agent.id);
      if (previous !== undefined && previous > 0 && previous < capacity && !claimed.has(previous)) {
        nextSeats.set(agent.id, previous);
        claimed.add(previous);
      }
    }
    for (const agent of uniqueAgents) {
      if (nextSeats.has(agent.id)) continue;
      let index = 1;
      while (claimed.has(index)) index++;
      nextSeats.set(agent.id, index);
      claimed.add(index);
    }
    const currentStatuses = new Map(uniqueAgents.map(agent => [agent.id, agent.status]));
    if (!nextSeats.has('boss')) { this.ownerAction = null; this.ownerFinishRequestedAt = null; }
    for (const flight of [...this.paperFlights]) {
      if (nextSeats.get(flight.fromId) !== flight.sender.seat || nextSeats.get(flight.toId) !== flight.recipient.seat) this.removePaperFlight(flight);
    }
    for (const [id, visit] of this.approvalVisits) {
      if (nextSeats.get(id) !== visit.figure.seat || !nextSeats.has('boss')) {
        this.restoreSeatedFigure(visit.figure);
        this.approvalVisits.delete(id);
        if (nextSeats.has(id) && nextSeats.has('boss') && currentStatuses.get(id) === 'approval') this.approvalRequests.add(id);
        else this.approvalRequests.delete(id);
      } else if (currentStatuses.get(id) !== 'approval' && visit.stage !== 'return') {
        // The visitor stood at the desk and the question ended without approval.resolved: the owner files the sheet and nods.
        if (visit.stage === 'waiting') this.ownerFinishRequestedAt = this.elapsed;
        this.returnFromApproval(visit);
      }
    }
    for (const id of this.approvalRequests) {
      if (!nextSeats.has(id) || currentStatuses.get(id) !== 'approval') this.approvalRequests.delete(id);
    }
    // An abandoned seat must never continue a handoff under its replacement's identity.
    for (let i = this.deliveries.length - 1; i >= 0; i--) {
      const delivery = this.deliveries[i]!;
      if (nextSeats.get(delivery.courier.id) === delivery.courier.seat
        && nextSeats.get(delivery.recipient.id) === delivery.recipient.seat) continue;
      this.restoreSeatedFigure(delivery.courier);
      delivery.courier.paper.visible = false;
      delivery.recipient.paper.visible = false;
      this.deliveries.splice(i, 1);
    }
    for (let i = this.queued.length - 1; i >= 0; i--) {
      const item = this.queued[i]!;
      if (!nextSeats.has(item.from) || !nextSeats.has(item.to)) this.queued.splice(i, 1);
    }
    // Move the existing person, not their identity onto another person's face, when closing rear desks.
    const previousFigures = [...this.figures];
    const previousScreens = previousFigures.map(figure => figure.screen);
    const reordered: AgentFigure[] = [];
    const retained = new Set<AgentFigure>();
    if (previousFigures[0]) { reordered[0] = previousFigures[0]; retained.add(previousFigures[0]); }
    for (const [id, index] of nextSeats) {
      const oldIndex = this.agentSeats.get(id);
      const figure = oldIndex === undefined ? undefined : previousFigures[oldIndex];
      if (!figure || figure.id !== id) continue;
      reordered[index] = figure; retained.add(figure);
    }
    let vacant = 0;
    for (const figure of previousFigures) {
      if (retained.has(figure)) continue;
      while (reordered[vacant]) vacant++;
      reordered[vacant] = figure;
    }
    this.figures.splice(0, this.figures.length, ...reordered);
    for (const [index, figure] of this.figures.entries()) {
      if (figure.seat === index) continue;
      const seat = seatPosition(index);
      this.cancelYawn(figure);
      figure.seat = index;
      figure.origin.set(seat.x, 0, seat.z);
      figure.halo.position.set(seat.x, .035, seat.z);
      figure.screen = previousScreens[index] ?? figure.screen;
      this.restoreSeatedFigure(figure);
    }
    // New figures are dressed for the person about to sit there, so arrivals never build a look twice.
    const seatIds: string[] = [];
    for (const [id, index] of nextSeats) seatIds[index] = id;
    this.ensureCapacity(capacity, seatIds);
    this.agentSeats.clear();
    for (const [id, index] of nextSeats) this.agentSeats.set(id, index);
    const releasedLooks = { roots: [] as THREE.Object3D[], keep: new Set<THREE.Material>() };
    for (const agent of uniqueAgents) {
      const index = nextSeats.get(agent.id);
      if (index === undefined) continue;
      const figure = this.figures[index];
      if (!figure) continue;
      const identityChanged = figure.id !== agent.id;
      const becameIdle = !['idle', 'waiting'].includes(figure.status) && ['idle', 'waiting'].includes(agent.status);
      if (identityChanged) { this.visibleBubbles.delete(figure.id); figure.bubble.style.display = 'none'; }
      if (identityChanged || !['idle', 'waiting'].includes(agent.status)) this.cancelYawn(figure);
      if (identityChanged || figure.status !== agent.status) {
        this.resetActionTimers(figure, agent.id);
        figure.doneAt = agent.status === 'done' ? this.elapsed : -Infinity;
      }
      figure.id = agent.id;
      figure.status = agent.status;
      figure.activityKind = agent.activityKind;
      // External (MCP) calls are employees only; approval, error or another person puts the phone down at once.
      const onCall = agent.id !== 'boss' && isExternalCall(agent as Parameters<typeof isExternalCall>[0]);
      if (figure.callBlend !== undefined && (identityChanged || agent.status === 'approval' || agent.status === 'error')) this.hangUp(figure);
      if (onCall && figure.phone && !figure.phoneScreen) this.buildPhoneScreen(figure);
      if (onCall) figure.callBlend ??= 0;
      if (onCall || figure.onCall !== undefined) figure.onCall = onCall;
      if (figure.phoneScreen) figure.phoneScreen.visible = onCall;
      if (figure.look && figure.look.agentId !== agent.id) this.dressFigure(figure, agent.id, releasedLooks);
      if (agent.id !== 'boss') {
        if (!figure.deskWork) { figure.deskWork = new DeskWork(); (this.workLayer ??= new THREE.Group()).add(figure.deskWork.group); }
        figure.deskWork.observe(agent, this.elapsed);
      }
      if (identityChanged || becameIdle) {
        figure.yawnCycle = 0;
        figure.nextYawnAt = this.elapsed + idleYawnDelay(agent.id);
      }
      figure.activity = activityMessage(agent);
      figure.bubbleWidth = activityBubbleWidth(figure.activity.text, false);
      figure.compactBubbleWidth = activityBubbleWidth(figure.activity.compactText, true);
      figure.bubble.dataset.status = agent.status;
      figure.bubble.title = figure.activity.fullText;
      if (figure.bubbleContent.textContent !== figure.activity.text) figure.bubbleContent.textContent = figure.activity.text;
      if (agent.showCharacter === false && figure.group.visible && this.focusId === agent.id && (this.following || this.cinematic)) {
        // Keep the chosen shot when its employee leaves, including an unfinished approval visit.
        this.targetGoal.copy(this.cameraTarget); this.zoomGoal = this.cameraZoom; this.framingGoal = this.framing;
        this.following = false; this.cinematic = false;
      }
      figure.group.visible = agent.showCharacter !== false;
      if (!figure.group.visible || !figure.activity.text || !this.activityBubblesVisible) figure.bubble.style.display = 'none';
      figure.halo.visible = figure.group.visible && !this.cardHidesMarkers(figure);
      figure.label.style.display = this.showAgentName(figure) ? 'flex' : 'none';
      const name = figure.label.querySelector('span:last-child');
      const nameText = `${agent.name ?? agent.id}${agent.id === 'boss' ? '' : ` · ${agent.modelEvidence === 'reported' && agent.model ? agent.model : '모델 미확인'}`}`;
      if (name) name.textContent = nameText;
      figure.nameWidth = activityBubbleWidth(nameText, false) + 8;
      // The owner's navy turtleneck is part of the owner's look; employees wear their reported model color.
      const appearance = appearanceFor(agent.id);
      figure.shirt.color.set(!appearance.isBoss && agent.color && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(agent.color)
        ? agent.color : appearance.seatShirt);
      if (figure.trim) shadeColor(figure.trim.color, figure.shirt.color, .92);
      if (figure.cuff) shadeColor(figure.cuff.color, figure.shirt.color, .9);
      const statusColor = statusStyleFor(agent.status).color;
      (figure.halo.material as THREE.MeshStandardMaterial).color.set(statusColor);
      if (figure.led) {
        const ledMaterial = figure.led.material as THREE.MeshStandardMaterial;
        ledMaterial.color.set(statusColor); ledMaterial.emissive.set(statusColor);
      }
      const labelDot = figure.label.querySelector<HTMLElement>('span:first-child');
      if (labelDot) labelDot.style.background = statusColor;
      for (const child of figure.signal.children) {
        if (child instanceof THREE.Mesh) (child.material as THREE.MeshStandardMaterial).color.set(statusColor);
      }
      this.syncSignal(figure);
      const screenMaterial = figure.screen.material as THREE.MeshStandardMaterial;
      screenMaterial.emissive.set(agent.status === 'error' ? PALETTE.peach : '#aecfc4');
      screenMaterial.emissiveIntensity = agent.status === 'error' ? .15
        : ['working', 'reviewing', 'thinking'].includes(agent.status) ? .28 : .05;
      if (figure.watchFace) figure.watchFace.emissiveIntensity = agent.status === 'working' ? .15 : 0;
    }
    // Swapped-out hair, clothes and accessories free only what no remaining person still shares.
    if (releasedLooks.roots.length && this.scene) this.releaseRoomObjects(releasedLooks.roots, false, releasedLooks.keep);
    for (const [index, figure] of this.figures.entries()) {
      if (!claimed.has(index) || index === 0 && !nextSeats.has('boss')) {
        figure.status = 'idle';
        this.cancelYawn(figure);
        figure.group.visible = false;
        figure.halo.visible = false;
        figure.label.style.display = 'none';
        figure.bubble.style.display = 'none';
        this.visibleBubbles.delete(figure.id);
        figure.signal.visible = false;
        figure.paper.visible = false;
        figure.deskWork?.dispose(); figure.deskWork = undefined;
        if (figure.onCall) figure.onCall = false;
        if (figure.phoneScreen) figure.phoneScreen.visible = false;
        if (figure.callBlend) this.hangUp(figure);
        (figure.screen.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
      }
    }
    if (this.focusId !== null && !nextSeats.has(this.focusId)) {
      if (this.following) this.focus(null, { cinematic: true });
      else this.focusId = null;
    }
    for (const agent of uniqueAgents) if (agent.status === 'approval' && previousStatuses.get(agent.id) !== 'approval') this.requestApproval(agent.id);
    this.startApprovalVisits();
    this.syncApprovalPile();
    this.container.dataset.capacity = String(this.figures.length);
    this.container.dataset.visibleAgents = String(this.figures.filter(figure => figure.group.visible).length);
    this.container.dataset.phoneCalls = String(this.figures.filter(figure => figure.group.visible && figure.onCall).length);
    this.container.dataset.omittedAgents = String(allAgents.length - uniqueAgents.length);
    this.requestHiddenFrame();
  }

  deliver(fromId: string, toId: string): void {
    if (fromId === toId) return;
    if (!this.agentSeats.has(fromId) || !this.agentSeats.has(toId)) return;
    if (this.queued.length > 18) this.queued.shift();
    this.queued.push({ from: fromId, to: toId });
    this.startNextDelivery();
  }

  /** Only the host's observed handoff event may call this. Missing endpoints are never synthesized. */
  sendPaperPlane(fromId: string, toId: string, eventId?: string): boolean {
    return this.startPaperFlight(fromId, toId, eventId);
  }

  /** A recorded message has one known computer; it never implies another employee received it. */
  sendMessagePlane(agentId: string, eventId: string): boolean {
    if (this.buildingView) return !this.disposed && !this.reducedMotion ? this.building?.sendMessagePlane(agentId, eventId) ?? false : false;
    return this.startPaperFlight(agentId, agentId, eventId, true);
  }

  /**
   * user.instruction: the owner reaches out and a plane leaves the owner's computer for the employee. Only a target
   * visible in this room is flown to; owner planes leave at most once per second and once per four seconds per target.
   * `false` also covers a throttled or duplicate request, so a caller should fall back to another plane only when the
   * owner plane cannot reach the target at all (building view, reduced motion, or a target not shown in this room),
   * never merely on `false`; a fallback must not bypass the owner-plane limits for a target that is shown here.
   */
  sendInstructionPlane(toAgentId: string, eventId: string): boolean {
    if (this.disposed || this.buildingView || this.reducedMotion || typeof toAgentId !== 'string' || toAgentId === 'boss') return false;
    const ownerSeat = this.agentSeats.get('boss'), targetSeat = this.agentSeats.get(toAgentId);
    const owner = ownerSeat === undefined ? undefined : this.figures[ownerSeat];
    const target = targetSeat === undefined ? undefined : this.figures[targetSeat];
    if (owner?.id !== 'boss' || target?.id !== toAgentId || !owner.group.visible || !target.group.visible) return false;
    if (eventId && this.seenPlaneEvents.has(eventId)) return false;
    const now = this.clockSeconds();
    const log = this.instructionLog ??= { lastAt: -Infinity, targets: new Map() };
    if (now - log.lastAt < INSTRUCTION_GAP_SECONDS || now - (log.targets.get(toAgentId) ?? -Infinity) < INSTRUCTION_TARGET_COOLDOWN_SECONDS) return false;
    if (!this.startPaperFlight('boss', toAgentId, eventId)) return false;
    log.lastAt = now;
    for (const [id, at] of log.targets) if (now - at >= INSTRUCTION_TARGET_COOLDOWN_SECONDS) log.targets.delete(id);
    log.targets.set(toAgentId, now);
    const flight = this.paperFlights.at(-1);
    if (flight) flight.plane.name = 'instruction-paper-plane';
    // The owner's reach replaces the generic push; a higher-priority moment keeps the plane and skips only the gesture.
    owner.pushUntil = 0;
    this.requestOwnerAction('instruct');
    return true;
  }

  /** While an employee's card is open, their name tag, three dots and markers above the head step aside at detail LOD. */
  setCardOpen(agentId: string | null): void {
    this.cardOpenId = typeof agentId === 'string' && agentId ? agentId : null;
    this.lastWorkDetailAt = -Infinity;
    for (const figure of this.figures) {
      figure.label.style.display = this.showAgentName(figure) ? 'flex' : 'none';
      this.syncSignal(figure);
      // Same rule as updateDetailLevels: the halo shows only for a detailed body whose card is closed.
      figure.halo.visible = figure.group.visible && figure.detail?.visible !== false && !this.cardHidesMarkers(figure);
    }
    this.requestHiddenFrame();
  }

  private startPaperFlight(fromId: string, toId: string, eventId?: string, localMessage = false): boolean {
    if (this.disposed || !localMessage && fromId === toId || eventId && this.seenPlaneEvents.has(eventId)) return false;
    const fromSeat = this.agentSeats.get(fromId), toSeat = this.agentSeats.get(toId);
    const sender = fromSeat === undefined ? undefined : this.figures[fromSeat];
    const recipient = toSeat === undefined ? undefined : this.figures[toSeat];
    if (sender?.id !== fromId || recipient?.id !== toId || !sender.screen || !recipient.screen) return false;
    if (this.paperFlights.length >= 32 || !eventId && this.paperFlights.some(flight => flight.fromId === fromId && flight.toId === toId)) return false;
    const start = sender.screen.getWorldPosition(new THREE.Vector3());
    const end = recipient.screen.getWorldPosition(new THREE.Vector3());
    const fromNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(sender.screen.getWorldQuaternion(new THREE.Quaternion()));
    const toRotation = recipient.screen.getWorldQuaternion(new THREE.Quaternion());
    const toNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(toRotation);
    const plane = foldedPaperPlane();
    const trail = paperPlaneTrail(); plane.add(trail);
    plane.scale.setScalar(paperPlaneScale((this.camera.top - this.camera.bottom) / (Math.max(1, this.container.clientHeight) * this.camera.zoom)));
    const arrival = new THREE.Mesh(new THREE.RingGeometry(.23, .29, 32),
      new THREE.MeshBasicMaterial({ color: '#299bbf', transparent: true, opacity: .85, side: THREE.DoubleSide, depthWrite: false }));
    arrival.name = 'handoff-computer-receipt';
    arrival.position.copy(end).addScaledVector(toNormal, .025);
    arrival.quaternion.copy(toRotation);
    arrival.visible = this.reducedMotion;
    const occupied = new Set(this.paperFlights.map(flight => flight.lane));
    let lane = 0; while (occupied.has(lane)) lane++;
    const curve = localMessage ? paperPlaneMessageCurve(start, fromNormal, lane) : paperPlaneCurve(start, end, fromNormal, toNormal, lane);
    const duration = localMessage ? 2.8 : THREE.MathUtils.clamp(3.2 + start.distanceTo(end) / 10 + lane * .025, 3.6, 7);
    if (localMessage) plane.name = 'message-paper-plane';
    const flight = { fromId, toId, sender, recipient, curve, plane, arrival, trail, lane, duration, elapsed: this.reducedMotion ? duration : 0 };
    if (!localMessage && !this.reducedMotion) sender.pushUntil = this.elapsed + .4;
    plane.position.copy(this.reducedMotion ? end : start);
    plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangent(0));
    plane.visible = !this.reducedMotion;
    this.effects.add(plane, arrival);
    this.paperFlights.push(flight);
    if (eventId) {
      this.seenPlaneEvents.add(eventId);
      if (this.seenPlaneEvents.size > 2048) this.seenPlaneEvents.delete(this.seenPlaneEvents.values().next().value!);
    }
    return true;
  }

  requestApproval(id: string): void {
    if (id === 'boss' || !this.agentSeats.has(id)) return;
    const figure = this.figures[this.agentSeats.get(id)!];
    if (figure) this.cancelYawn(figure);
    this.approvalRequests.add(id);
    this.syncApprovalPile();
    this.startApprovalVisits();
  }

  /**
   * The host's company-wide count of current approval requests (errors excluded) sets the owner's tray, so requests on
   * other floors are filed too. Visits still follow seated requests. A count that did not change toggles nothing.
   */
  setApprovalCount(count: number): void {
    if (typeof count !== 'number' || !Number.isFinite(count)) return;
    const next = Math.max(0, Math.floor(count));
    if (next === this.approvalCount) return;
    this.approvalCount = next;
    const before = this.approvalPile?.count;
    this.syncApprovalPile();
    if (this.approvalPile && this.approvalPile.count !== before) this.requestHiddenFrame();
  }

  resolveApproval(id: string): void {
    this.approvalRequests.delete(id);
    this.syncApprovalPile();
    const visit = this.approvalVisits.get(id);
    if (visit) this.returnFromApproval(visit);
    this.stamp(id);
    this.stampPending = true;
  }

  /** Settings names on the office sign and the owner's nameplate; a name that did not change redraws nothing. */
  setOwnerNames(names: { companyName: string; ownerName: string }): void {
    const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
    const next = { companyName: text(names?.companyName), ownerName: text(names?.ownerName) };
    const current = this.ownerNames ?? { companyName: '', ownerName: '' };
    const first = !this.ownerNamesApplied;
    this.ownerNames = next;
    this.ownerNamesApplied = true;
    if (next.companyName !== current.companyName) this.paintLettering('sign');
    if (next.ownerName !== current.ownerName) this.paintLettering('nameplate');
    if (first || next.companyName !== current.companyName) this.building?.setCompanyName?.(next.companyName);
  }

  /** Router LED: green while the bridge is connected, amber when it is not, and two green blinks on reconnection. */
  setBridgeConnected(connected: boolean): void {
    const next = connected === true, previous = this.bridgeConnected ?? null;
    if (previous === next) return;
    this.bridgeConnected = next;
    const now = this.clockSeconds();
    this.routerReconnectAt = previous === false && next && !this.ambientMotionOff() ? now : -Infinity;
    this.routerPulseAt = -Infinity;
    this.updateRouterLed(now);
  }

  /** A received event flashes the connected LED for .15s, at most twice per second; ambient motion off never flashes. */
  pulseRouter(): void {
    if (this.disposed || this.bridgeConnected !== true || this.ambientMotionOff()) return;
    const now = this.clockSeconds();
    if (now - (this.routerPulseAt ?? -Infinity) < ROUTER_PULSE_GAP_SECONDS
      || now - (this.routerReconnectAt ?? -Infinity) < ROUTER_RECONNECT_SECONDS) return;
    this.routerPulseAt = now;
    this.updateRouterLed(now);
  }

  setPaused(paused: boolean): void { this.paused = paused; }
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    this.syncRenderLoop();
  }
  setAutoRotate(enabled: boolean): void {
    if (enabled && !this.autoRotate) this.manualProjectionBase = undefined;
    this.autoRotate = enabled;
    this.autoRotateAfter = 0;
  }
  setLabelsVisible(visible: boolean): void {
    this.labelsVisible = visible;
    for (const figure of this.figures) figure.label.style.display = this.showAgentName(figure) ? 'flex' : 'none';
  }
  private showAgentName(figure: AgentFigure): boolean {
    return this.labelsVisible && figure.group.visible && !this.cardHidesMarkers(figure) && (this.focusId === figure.id
      || isWorkingStatus(figure.status) || figure.status === 'approval' || figure.status === 'error');
  }
  /** The card already names the person and shows the status, so their head-top markers hide while it is open up close. */
  private cardHidesMarkers(figure: AgentFigure): boolean {
    const open = this.cardOpenId ?? null;
    return open !== null && figure.id === open && figure.detail?.visible !== false;
  }
  private syncSignal(figure: AgentFigure): void {
    if (!figure.signal) return;
    const visible = figure.group.visible && SIGNAL_STATUSES.has(figure.status) && !this.cardHidesMarkers(figure);
    if (figure.signal.visible !== visible) figure.signal.visible = visible;
  }
  setActivityBubblesVisible(visible: boolean): void {
    this.activityBubblesVisible = visible;
    if (!visible) {
      this.visibleBubbles.clear();
      for (const figure of this.figures) figure.bubble.style.display = 'none';
    }
  }
  setPowerSaving(enabled: boolean): void {
    this.powerSaving = enabled;
    // The building keeps its markers and windows but stops its motion, the same rule as the office.
    this.building?.setPowerSaving?.(enabled);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, enabled ? 1.25 : 2));
    this.resize();
  }
  stamp(id: string): void {
    const index = this.agentSeats.get(id);
    const figure = index === undefined ? undefined : this.figures[index];
    if (!figure) return;
    figure.label.dataset.confirmed = 'true';
    window.setTimeout(() => { delete figure.label.dataset.confirmed; }, 2000);
  }
  setSpeed(speed: number): void { this.speed = THREE.MathUtils.clamp(speed, .25, 4); }
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      for (const figure of this.figures) this.cancelYawn(figure);
      this.ownerAction = null; this.ownerFinishRequestedAt = null; this.ownerClicks = [];
      for (const flight of this.paperFlights) {
        flight.elapsed = Math.max(flight.elapsed, flight.duration);
        flight.plane.position.copy(flight.curve.getPoint(1));
        flight.plane.visible = false;
        flight.arrival.visible = true;
        flight.arrival.scale.setScalar(1);
      }
    }
    if (reduced && this.cinematic) {
      this.cinematic = false;
      this.cameraZoom = this.zoomGoal;
      this.framing = this.framingGoal;
      this.cameraTarget.copy(this.targetGoal);
      this.resize();
    }
  }

  setBuildingFloors(floors: BuildingFloorInput[]): void {
    if (!this.building) return;
    const radius = this.building.radius;
    this.building.setFloors(floors);
    if (this.buildingView && radius !== this.building.radius) {
      this.resize(false);
      const abandonedPan = radius > this.building.radius && this.manualProjectionBase !== undefined
        && !this.building.bounds.containsPoint(this.targetGoal);
      if (abandonedPan || this.manualProjectionBase === undefined && performance.now() >= (this.motion?.heldUntilMs ?? 0) && !this.isZoomedIn()) {
        if (this.manualProjectionBase === undefined) this.aimBuildingApproach(this.buildingFocus);
        else this.targetGoal.copy(this.building.focusPoint(this.buildingFocus));
      }
    }
  }
  hasVisibleAgent(id: string): boolean { return this.buildingView ? !!this.building?.hasAgent(id) : this.agentSeats.has(id); }
  sendBuildingPaperPlane(from: string, to: string, eventId: string): boolean {
    return this.buildingView && !this.reducedMotion ? this.building?.sendPaperPlane(from, to, eventId) ?? false : false;
  }
  setBuildingView(enabled: boolean, projectId = ''): void {
    if (!this.building) return;
    const changed = this.buildingView !== enabled || this.buildingFocus !== projectId;
    if (changed) this.manualProjectionBase = undefined;
    // A floor the viewer focused belongs to that visit; the next building entry starts without haze.
    if (this.buildingView && !enabled) this.building.focusFloor?.(null);
    // A shot of another project (automatic watching) releases a different focused floor, so the haze and the camera agree.
    else if (this.buildingView && enabled && this.buildingFocus !== projectId) {
      const focused = this.building.focusedFloor;
      if (focused && focused !== projectId) this.building.focusFloor?.(null);
    }
    this.buildingView = enabled; this.buildingFocus = projectId;
    this.world.visible = !enabled; this.effects.visible = !enabled;
    if (this.workLayer) this.workLayer.visible = !enabled;
    this.building.show(enabled, projectId);
    this.container.dataset.view = enabled ? 'building' : 'office';
    if (enabled) {
      this.following = false; this.focusId = null;
      if (changed) {
        this.cinematicStartTarget.copy(this.cameraTarget); this.cinematicStartZoom = this.cameraZoom;
        this.cinematicStartFraming = this.framing; this.framingGoal = 0;
        this.zoomGoal = this.aimBuildingApproach(projectId); this.automaticZoom = this.zoomGoal; this.cinematicElapsed = 0; this.cinematic = !this.reducedMotion;
        this.cinematicSeconds = undefined;
        if (this.reducedMotion) { this.cameraTarget.copy(this.targetGoal); this.cameraZoom = this.zoomGoal; this.framing = 0; }
      }
    }
    if (changed) this.resize();
  }

  /** The page reports its HUD blocks (CSS pixels from each stage edge); the building shot fits the whole model between them. */
  setHudInsets(insets: BuildingHudInsets): void {
    const clean = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    const same = (a: HudInsets | null, b: HudInsets | null) => a === b
      || !!a && !!b && a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
    const next = { top: clean(insets?.top), right: clean(insets?.right), bottom: clean(insets?.bottom), left: clean(insets?.left) };
    const reported = insets?.beside && typeof insets.beside === 'object' ? insets.beside : null;
    const beside = reported ? { top: clean(reported.top), right: clean(reported.right), bottom: clean(reported.bottom), left: clean(reported.left) } : null;
    if (this.hudInsets && same(this.hudInsets, next) && same(this.hudInsetsBeside, beside)) return;
    this.hudInsets = next; this.hudInsetsBeside = beside;
    if (this.buildingView) this.resize(false);
  }

  /**
   * First building entry (decision 47): the camera is placed on `fromProjectId` without motion and rises to the whole
   * building over `durationMs`. Returns false, changing nothing, when the floor is unknown, motion is reduced or paused.
   */
  playBuildingIntro(fromProjectId: string, durationMs: number): boolean {
    const seconds = Number(durationMs) / 1000;
    if (!this.building || this.disposed || this.reducedMotion || this.paused || !(seconds > 0)
      || typeof fromProjectId !== 'string' || !this.building.hasFloor(fromProjectId)) return false;
    this.setBuildingView(true, fromProjectId);
    this.cinematic = false;
    this.cameraTarget.copy(this.targetGoal); this.cameraZoom = this.zoomGoal; this.framing = 0;
    this.resize(false);
    this.setBuildingView(true);
    this.cinematicSeconds = Math.min(10, seconds);
    return true;
  }

  /** Moves the building camera to a focused floor (or back to the whole building for null) without changing the shown project. */
  private glideToBuildingFloor(projectId: string | null): void {
    const building = this.building;
    if (!building || this.disposed || !this.buildingView) return;
    this.manualProjectionBase = undefined;
    this.cinematicStartTarget.copy(this.cameraTarget); this.cinematicStartZoom = this.cameraZoom;
    this.cinematicStartFraming = this.framing; this.framingGoal = 0;
    this.zoomGoal = this.aimBuildingApproach(projectId ?? ''); this.automaticZoom = this.zoomGoal;
    this.cinematicElapsed = 0; this.cinematicSeconds = undefined; this.cinematic = !this.reducedMotion;
    if (this.reducedMotion) { this.cameraTarget.copy(this.targetGoal); this.cameraZoom = this.zoomGoal; this.framing = 0; }
    this.autoRotateAfter = performance.now() + 5000;
    this.resize();
  }

  stopFollowing(): void { this.noteManualInteraction(); }

  /** True while the user has zoomed in past the shot the office chose (overview, follow shot or building). */
  isZoomedIn(): boolean {
    return this.cameraZoom > (this.automaticZoom ?? 1) * 1.05 + 1e-6;
  }

  focus(id: string | null, options: { cinematic?: boolean; zoom?: number } = {}): void {
    this.manualProjectionBase = undefined;
    if (this.buildingView) this.setBuildingView(false);
    const index = id === null ? undefined : this.agentSeats.get(id);
    const figure = index === undefined ? undefined : this.figures[index];
    this.focusId = figure ? id : null;
    this.following = !!figure?.group.visible;
    this.cinematic = options.cinematic === true && !this.reducedMotion;
    this.cinematicElapsed = 0; this.cinematicSeconds = undefined;
    this.cinematicStartZoom = this.cameraZoom;
    this.cinematicStartFraming = this.framing;
    this.framingGoal = figure ? 1 : 0;
    this.cinematicStartTarget.copy(this.cameraTarget);
    if (figure) {
      this.targetGoal.copy(figure.group.visible ? figure.group.position : figure.origin).add(new THREE.Vector3(0, 1.15, 0));
      this.zoomGoal = clampZoom(options.zoom ?? (options.cinematic ? 1.65 : 2.4));
    } else {
      this.targetGoal.set(this.bounds.centerX, .3, this.bounds.centerZ);
      this.zoomGoal = 1;
    }
    this.automaticZoom = this.zoomGoal;
    if (!this.cinematic) { this.cameraZoom = this.zoomGoal; this.framing = this.framingGoal; }
    this.autoRotateAfter = performance.now() + 5000;
    this.resize();
  }

  resetCamera(): void {
    this.manualProjectionBase = undefined;
    this.yaw = .61;
    this.elevation = .81;
    this.cameraZoom = 1;
    if (this.buildingView && this.building) this.targetGoal.copy(this.building.center);
    else this.targetGoal.set(this.bounds.centerX, .3, this.bounds.centerZ);
    this.approachId = '';
    this.zoomGoal = 1;
    this.automaticZoom = 1;
    this.framing = 0;
    this.cinematic = false;
    this.focusId = null;
    this.following = false;
    this.autoRotateAfter = performance.now() + 5000;
    this.resize();
  }

  zoom(delta: number): void {
    this.noteManualInteraction();
    this.cameraZoom = clampZoom(this.cameraZoom + delta);
    this.resize();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationId);
    this.observer.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.removeEventListener('pointerup', this.pointerUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.pointerCancel);
    this.renderer.domElement.removeEventListener('lostpointercapture', this.pointerCancel);
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);
    this.renderer.domElement.removeEventListener('keydown', this.onKeyDown);
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.renderer.domElement.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.cancelPointers();
    this.building?.dispose();
    this.workMarkers?.dispose();
    for (const figure of this.figures) figure.deskWork?.dispose();
    this.workLayer?.removeFromParent();
    for (const flight of [...this.paperFlights]) this.removePaperFlight(flight);
    this.seenPlaneEvents.clear();
    this.effects.removeFromParent();
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposedTextures = new Set<THREE.Texture>();
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      if (!disposedGeometries.has(object.geometry)) {
        object.geometry.dispose();
        disposedGeometries.add(object.geometry);
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (disposedMaterials.has(material)) continue;
        if (material instanceof THREE.MeshStandardMaterial && material.map && !disposedTextures.has(material.map)) {
          material.map.dispose();
          disposedTextures.add(material.map);
        }
        material.dispose();
        disposedMaterials.add(material);
      }
    });
    for (const geometry of this.geometryCache.values()) if (!disposedGeometries.has(geometry)) geometry.dispose();
    this.geometryCache.clear();
    for (const material of this.materials.values()) if (!disposedMaterials.has(material)) material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.figures.forEach(figure => { figure.label.remove(); figure.bubble.remove(); });
    this.visibleBubbles.clear();
    delete this.container.dataset.sceneReady;
    delete this.container.dataset.drawCalls;
    delete this.container.dataset.triangles;
    delete this.container.dataset.animationState;
    delete this.container.dataset.capacity;
    delete this.container.dataset.visibleAgents;
    delete this.container.dataset.phoneCalls;
    delete this.container.dataset.omittedAgents;
    delete this.container.dataset.workProps;
    delete this.container.dataset.workKinds;
  }

  private batchStaticMeshes(parent: THREE.Group = this.world): void {
    const mutableRoots = new Set<THREE.Object3D>([this.backWall, this.leftWall,
      ...this.figures.flatMap(figure => [figure.group, figure.halo, figure.screen])]);
    if (parent === this.world) for (const root of [this.roomShell, ...this.fixtureRows.values()]) mutableRoots.add(root);
    if (parent === this.world && this.wallDecor) mutableRoots.add(this.wallDecor);
    if (this.ownerSign) mutableRoots.add(this.ownerSign);
    if (this.ownerDeskLive) mutableRoots.add(this.ownerDeskLive);
    const batches = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.Material>[]>();
    this.world.updateMatrixWorld(true);
    const worldInverse = parent.matrixWorld.clone().invert();
    parent.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || Array.isArray(object.material)) return;
      // Glass needs individual depth sorting; all animated figures and changing screens stay intact.
      if (object.material.transparent) return;
      for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
        if (mutableRoots.has(ancestor)) return;
      }
      const attributes = Object.keys(object.geometry.attributes).sort().join(',');
      const key = `${object.material.uuid}/${object.castShadow}/${object.receiveShadow}/${object.renderOrder}/${attributes}`;
      const batch = batches.get(key) ?? [];
      batch.push(object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>);
      batches.set(key, batch);
    });
    const detachedGeometries = new Set<THREE.BufferGeometry>();
    for (const meshes of batches.values()) {
      if (meshes.length < 2) continue;
      const geometries = meshes.map(mesh => {
        // Primitive geometries mix indexed and non-indexed formats, so normalize before merging.
        const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        geometry.clearGroups();
        geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(worldInverse, mesh.matrixWorld));
        return geometry;
      });
      const geometry = mergeGeometries(geometries, false);
      for (const temporary of geometries) temporary.dispose();
      if (!geometry) continue;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const first = meshes[0]!;
      const merged = new THREE.Mesh(geometry, first.material);
      merged.name = 'static-office-batch';
      merged.castShadow = first.castShadow;
      merged.receiveShadow = first.receiveShadow;
      merged.renderOrder = first.renderOrder;
      parent.add(merged);
      for (const mesh of meshes) {
        mesh.removeFromParent();
        detachedGeometries.add(mesh.geometry);
      }
    }
    // Dispose only detached geometries that no remaining static or dynamic mesh shares.
    const retainedGeometries = new Set<THREE.BufferGeometry>();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh) retainedGeometries.add(object.geometry);
    });
    for (const geometry of detachedGeometries) {
      if (!retainedGeometries.has(geometry) && ![...this.geometryCache.values()].includes(geometry)) geometry.dispose();
    }
  }

  private material(color: string, roughness = .78, metalness = 0): THREE.MeshStandardMaterial {
    const key = `${color}/${roughness}/${metalness}`;
    const existing = this.materials.get(key);
    if (existing) return existing;
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.materials.set(key, material);
    return material;
  }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D,
    x = 0, y = 0, z = 0): THREE.Mesh {
    if (geometry.type !== 'ExtrudeGeometry' && geometry.type !== 'BufferGeometry') {
      const key = `${geometry.type}/${JSON.stringify((geometry as THREE.BufferGeometry & { parameters?: unknown }).parameters)}`;
      const shared = this.geometryCache.get(key);
      if (shared && shared !== geometry) { geometry.dispose(); geometry = shared; }
      else this.geometryCache.set(key, geometry);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private box(parent: THREE.Object3D, width: number, height: number, depth: number,
    x: number, y: number, z: number, color: string, radius = .05): THREE.Mesh {
    const r = Math.min(radius, width / 2.1, height / 2.1, depth / 2.1);
    if (r < .015) return this.mesh(new THREE.BoxGeometry(width, height, depth), this.material(color), parent, x, y, z);
    const cacheKey = `rounded-box/${width}/${height}/${depth}/${r}`;
    const cached = this.geometryCache.get(cacheKey);
    if (cached) return this.mesh(cached, this.material(color), parent, x, y, z);
    const shape = new THREE.Shape();
    const w = width / 2 - r;
    const h = height / 2 - r;
    shape.moveTo(-w, -h - r);
    shape.lineTo(w, -h - r);
    shape.quadraticCurveTo(w + r, -h - r, w + r, -h);
    shape.lineTo(w + r, h);
    shape.quadraticCurveTo(w + r, h + r, w, h + r);
    shape.lineTo(-w, h + r);
    shape.quadraticCurveTo(-w - r, h + r, -w - r, h);
    shape.lineTo(-w - r, -h);
    shape.quadraticCurveTo(-w - r, -h - r, -w, -h - r);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: depth - r * 2, bevelEnabled: true, bevelThickness: r,
      bevelSize: r * .45, bevelSegments: 2, steps: 1, curveSegments: 4,
    });
    geometry.translate(0, 0, -depth / 2 + r);
    this.geometryCache.set(cacheKey, geometry);
    return this.mesh(geometry, this.material(color), parent, x, y, z);
  }

  private sphere(parent: THREE.Object3D, radius: number, x: number, y: number, z: number,
    color: string, sx = 1, sy = 1, sz = 1, segments = 16): THREE.Mesh {
    const sphere = this.mesh(new THREE.SphereGeometry(radius, segments, Math.max(4, Math.round(segments * .75))), this.material(color), parent, x, y, z);
    sphere.scale.set(sx, sy, sz);
    return sphere;
  }

  private cylinder(parent: THREE.Object3D, top: number, bottom: number, height: number,
    x: number, y: number, z: number, color: string, segments = 24): THREE.Mesh {
    return this.mesh(new THREE.CylinderGeometry(top, bottom, height, segments), this.material(color), parent, x, y, z);
  }

  private buildLighting(): void {
    this.scene.add(new THREE.HemisphereLight('#fff9e9', '#99aaa1', 2.2));
    const sun = new THREE.DirectionalLight('#fff3df', 3.2);
    this.sunLight = sun;
    sun.position.set(-8, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    sun.shadow.normalBias = .035;
    sun.shadow.bias = -.0002;
    sun.shadow.radius = 5;
    this.scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight('#d5e9ff', 1.1);
    fill.position.set(10, 7, -9);
    this.scene.add(fill);
  }

  private buildRoom(): void {
    this.roomShell.name = 'office-shell';
    this.wallDecor = new THREE.Group();
    this.wallDecor.name = 'back-wall-decor';
    this.world.add(this.roomShell, this.backWall, this.wallDecor, this.leftWall);
    this.backWall.name = 'cutaway-back-wall';
    this.leftWall.name = 'cutaway-left-wall';
    this.rebuildShell();
    // The owner has an enclosed wing and an open reception aisle to the employee floor.
    this.box(this.world, 7.8, .025, 5.2, -10, .01, -4.1, '#c7d8cc', .14);
    // The back wall's front face; minZ is the same for every roster size, so these pieces are never rebuilt.
    const wallFace = this.bounds.minZ + .1;
    // Glass and top rail run from the wall face (-7.75) to the unchanged open end (-2.95); the rear post touches the wall.
    const glass = this.box(this.world, .065, 2.6, 4.8, -6.15, 1.3, -5.35, '#bcd8e6', .01);
    glass.material = new THREE.MeshStandardMaterial({ color: '#bcd8e6', transparent: true, opacity: .2, roughness: .3, depthWrite: false });
    glass.castShadow = false;
    for (const z of [wallFace + .055, -3]) this.box(this.world, .11, 2.65, .11, -6.15, 1.32, z, '#96acb5', .02);
    this.box(this.world, .12, .1, 4.8, -6.15, 2.67, -5.35, '#96acb5', .02);
    // The sign board sits flush on the wall face right of the owner's window; its lettering is a child so both hide with the back wall.
    const signBoard = this.box(this.world, 3.3, .5, .12, -9.3, 1.99, wallFace + .06, '#91aba9', .05);
    signBoard.name = 'owner-office-sign';
    this.ownerSign = signBoard;
    this.createLettering('sign', signBoard, 3.05, .46, 0, .01, .08);
    this.ownerWingDecor(this.world);
    this.receptionDecor(this.world);
    this.batchStaticMeshes();
  }

  /** A lettering plane whose canvas texture is painted from the current settings names; null without a 2D canvas. */
  private createLettering(kind: 'sign' | 'nameplate', parent: THREE.Object3D, width: number, height: number, x: number, y: number, z: number): THREE.Mesh | null {
    const canvas = document.createElement('canvas');
    if (!canvas.getContext?.('2d')) return null;
    const mesh = this.mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ roughness: 1 }), parent, x, y, z);
    mesh.name = `owner-${kind}-lettering`;
    mesh.castShadow = false;
    if (kind === 'sign') this.signLettering = mesh; else this.nameplateLettering = mesh;
    this.paintLettering(kind, canvas);
    return mesh;
  }

  /** Draws one label into a new canvas texture and releases the texture it replaces. Text is drawn, never parsed as markup. */
  private paintLettering(kind: 'sign' | 'nameplate', canvas: HTMLCanvasElement = document.createElement('canvas')): boolean {
    const mesh = kind === 'sign' ? this.signLettering : this.nameplateLettering;
    const context = canvas.getContext?.('2d');
    if (!mesh || !context) return false;
    const spec = LETTERING[kind], names = this.ownerNames ?? { companyName: '', ownerName: '' };
    canvas.width = spec.width; canvas.height = spec.height;
    context.fillStyle = spec.background; context.fillRect(0, 0, spec.width, spec.height);
    context.font = `600 ${spec.font}px Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif`;
    context.fillStyle = spec.color; context.textAlign = 'center'; context.textBaseline = 'middle';
    const measure = (text: string): number => {
      const width = context.measureText?.(text)?.width;
      return typeof width === 'number' && Number.isFinite(width) ? width : estimateTextWidth(text, spec.font);
    };
    // A long company name is shortened at its end; the '대표실' / '대표' suffix always stays whole.
    const text = fitNameLabel(kind === 'sign' ? names.companyName : names.ownerName, spec.suffix, spec.width - spec.padding * 2, measure);
    context.fillText(text, spec.width / 2, spec.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = mesh.material as THREE.MeshStandardMaterial;
    const previous = material.map;
    material.map = texture;
    material.needsUpdate = true;
    previous?.dispose();
    mesh.userData.lettering = text;
    return true;
  }

  /** Behind the owner's chair: a low wooden credenza with standing books, a globe, a small plant and two shape frames. */
  private ownerWingDecor(parent: THREE.Object3D): void {
    const wood = PALETTE.wood, trim = shadeHex(wood, .9);
    this.plant(-13.6, -7.05, 1.25, '#d5ae91', 0, parent, 2);
    for (const x of [-11.5, -8.5]) for (const z of [-7.68, -7.3]) this.box(parent, .08, .12, .08, x, .06, z, trim, .015);
    this.box(parent, 3.2, .6, .48, -10, .42, -7.48, wood, .05);
    this.box(parent, 3.36, .07, .57, -10, .755, -7.465, shadeHex(wood, 1.06), .03);
    for (const x of [-10.53, -9.47]) this.box(parent, .012, .5, .01, x, .42, -7.235, trim, 0);
    for (const x of [-10.7, -10.36, -9.64, -9.3]) this.sphere(parent, .024, x, .46, -7.23, trim, 1, 1, 1, 8);
    let bookX = -11.42;
    for (const [color, width, height] of [[PALETTE.lavender, .12, .42], [PALETTE.blue, .1, .36], [PALETTE.peach, .14, .4], [PALETTE.sage, .1, .33], [PALETTE.yellow, .12, .38]] as const) {
      this.box(parent, width, height, .26, bookX + width / 2, .79 + height / 2, -7.49, color, .012);
      bookX += width + .015;
    }
    this.box(parent, .16, .06, .26, bookX + .12, .82, -7.49, PALETTE.white, .01);
    // Globe on a short stem with a meridian arc behind it and two soft continents facing the room.
    this.cylinder(parent, .13, .13, .04, -10.1, .81, -7.46, '#8d9a8a', 16);
    this.cylinder(parent, .02, .02, .08, -10.1, .87, -7.46, '#8d9a8a', 8);
    this.sphere(parent, .21, -10.1, 1.1, -7.46, PALETTE.blue, 1, 1, 1, 16);
    this.sphere(parent, .09, -10.195, 1.17, -7.286, PALETTE.mint, 1.2, .8, .45, 10);
    this.sphere(parent, .05, -9.995, 1.02, -7.296, PALETTE.mint, 1, .8, .5, 8);
    const meridian = this.mesh(new THREE.TorusGeometry(.245, .012, 5, 20, Math.PI), this.material('#8d9a8a'), parent, -10.1, 1.1, -7.46);
    meridian.rotation.set(0, -Math.PI / 2, Math.PI / 2);
    meridian.castShadow = false;
    this.plant(-9.55, -7.47, .55, '#dfc7b4', .79, parent, 2);
    // Two frames with simple shapes lean on the wall; no photo, lettering or numbers.
    for (const [x, y, width, height, shape] of [[-8.96, 1.07, .44, .54, 'circle'], [-8.52, .99, .4, .38, 'triangle']] as const) {
      const frame = new THREE.Group();
      frame.position.set(x, y, -7.655);
      frame.rotation.x = -.1;
      parent.add(frame);
      this.box(frame, width, height, .03, 0, 0, 0, wood, .012);
      this.box(frame, width - .12, height - .12, .01, 0, 0, .018, PALETTE.cream, 0);
      if (shape === 'circle') this.sphere(frame, .09, 0, 0, .026, PALETTE.peach, 1, 1, .25, 12);
      else this.mesh(new THREE.CylinderGeometry(0, .1, .01, 3), this.material(PALETTE.sage), frame, 0, -.01, .027).rotation.x = -Math.PI / 2;
    }
  }

  /** Reception: approval queue markers, a lounge that waiting employees never use, and the water cooler. */
  private receptionDecor(parent: THREE.Object3D): void {
    // Queue rug under the nine approval spots, a footprint sticker on every spot, and a belt behind the last row.
    this.box(parent, 4.9, .025, 3.85, -10, .01, .525, '#dbe5eb', .12);
    // A rougher sticker tone keeps the stickers out of the glass partition frame's material batch.
    const sticker = this.material('#96acb5', .9);
    for (let slot = 0; slot < 9; slot++) {
      const spot = approvalSpot(slot);
      this.cylinder(parent, .42, .42, .006, spot.x, .027, spot.z, PALETTE.cream, 28).castShadow = false;
      const ring = this.mesh(new THREE.TorusGeometry(.41, .016, 4, 28), sticker, parent, spot.x, .03, spot.z);
      ring.rotation.x = Math.PI / 2;
      ring.castShadow = false;
      for (const side of [-1, 1]) {
        this.mesh(new THREE.BoxGeometry(.11, .006, .2), sticker, parent, spot.x + side * .1, .033, spot.z + .04).castShadow = false;
        this.mesh(new THREE.CylinderGeometry(.05, .05, .006, 10), sticker, parent, spot.x + side * .1, .033, spot.z - .12).castShadow = false;
      }
    }
    const post = '#465b6e';
    for (const x of [-12.15, -7.85]) {
      this.cylinder(parent, .17, .17, .04, x, .02, 2.95, post, 18);
      this.cylinder(parent, .035, .035, .88, x, .48, 2.95, shadeHex(post, 1.12), 10);
      this.sphere(parent, .065, x, .95, 2.95, post, 1, 1, 1, 12);
    }
    const belt = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-12.15, .86, 2.95), new THREE.Vector3(-10, .58, 2.95), new THREE.Vector3(-7.85, .86, 2.95));
    this.mesh(new THREE.TubeGeometry(belt, 20, .028, 6), this.material(PALETTE.sage), parent);
    // Lounge: a two-seat clay sofa against the left wall, a low round table, a stool, a floor lamp and a cactus.
    this.cylinder(parent, 1.55, 1.55, .02, -10.6, .01, 4.75, PALETTE.mint, 32);
    const sofa = PALETTE.lavender;
    this.box(parent, .42, 1.06, 2.4, -13.39, .65, 4.75, sofa, .16);
    this.box(parent, .88, .4, 2.1, -12.84, .32, 4.75, sofa, .14);
    for (const z of [4.25, 5.25]) this.box(parent, .72, .14, .94, -12.84, .59, z, shadeHex(sofa, 1.08), .06);
    for (const z of [3.57, 5.95]) this.box(parent, 1.24, .7, .3, -12.98, .47, z, sofa, .13);
    for (const x of [-13.5, -12.46]) for (const z of [3.5, 6]) this.cylinder(parent, .04, .04, .12, x, .06, z, shadeHex(PALETTE.wood, .9), 8);
    this.cylinder(parent, .28, .3, .04, -10.6, .02, 4.75, '#b8b5a3', 20);
    this.cylinder(parent, .1, .1, .58, -10.6, .33, 4.75, '#b8b5a3', 14);
    this.cylinder(parent, .62, .6, .08, -10.6, .66, 4.75, '#d7c3a8', 32);
    this.cup(-10.35, .7, 4.62, '#b9d4df', parent);
    this.cylinder(parent, .11, .11, .02, -10.85, .71, 4.92, PALETTE.white, 16);
    this.cylinder(parent, .28, .3, .46, -9.15, .23, 5.55, PALETTE.yellow, 24);
    this.cylinder(parent, .2, .2, .05, -13.85, .025, 6.05, '#8d9a8a', 18);
    this.cylinder(parent, .03, .03, 1.62, -13.85, .86, 6.05, '#8d9a8a', 8);
    this.mesh(new THREE.CylinderGeometry(.22, .35, .4, 20), this.material(PALETTE.sage), parent, -13.85, 1.86, 6.05);
    this.cylinder(parent, .3, .3, .012, -13.85, 1.655, 6.05, PALETTE.white, 20).castShadow = false;
    this.plant(-13.8, 2.55, 1, '#dfc7b4', 0, parent, 1);
    // Water cooler beside the reception, clear of the corridor and the approval waiting grid.
    this.box(parent, .5, 1.1, .5, -6.4, .55, 5.6, PALETTE.floor, .04);
    this.cylinder(parent, .17, .17, .38, -6.4, 1.3, 5.6, '#c2dce9', 14);
    this.cylinder(parent, .06, .06, .1, -6.4, 1.53, 5.6, PALETTE.blue, 10);
    this.box(parent, .06, .1, .04, -6.5, .95, 5.85, PALETTE.blue, .01);
    this.box(parent, .06, .1, .04, -6.3, .95, 5.85, PALETTE.peach, .01);
  }

  private rebuildShell(): void {
    this.clockHands = null;
    // Time-of-day glass, the floor light patch and the router LED keep their dedicated materials across rebuilds.
    const keep = new Set<THREE.Material>();
    for (const material of [this.windowGlass, this.windowPatch, this.routerLedMaterial]) if (material) keep.add(material);
    this.releaseRoomObjects([this.roomShell, this.backWall, this.leftWall, ...(this.wallDecor ? [this.wallDecor] : [])].flatMap(group => [...group.children]), false, keep);
    const b = this.bounds;
    this.box(this.roomShell, b.width, .5, b.depth, b.centerX, -.36, b.centerZ, '#c6d4de', .15);
    this.box(this.roomShell, b.width - .2, .12, b.depth - .2, b.centerX, -.075, b.centerZ, PALETTE.floor, .1);
    for (let x = b.minX + 1; x < b.maxX; x += 3) this.box(this.roomShell, .014, .005, b.depth - .5, x, -.008, b.centerZ, PALETTE.line, 0);
    for (let z = b.minZ + 1; z < b.maxZ; z += 3) this.box(this.roomShell, b.width - .5, .005, .014, b.centerX, -.008, z, PALETTE.line, 0);
    // A pale continuous aisle makes department-to-department routes legible from above.
    this.box(this.roomShell, 1.65, .01, b.depth - .5, -4.7, .006, b.centerZ, '#d0e1e9', .03);
    this.box(this.backWall, b.width, 2.5, .2, b.centerX, 1.18, b.minZ, PALETTE.cream, .04);
    this.box(this.leftWall, .2, 1.15, b.depth, b.minX, .5, b.centerZ, PALETTE.cream, .04);
    this.rightStripDecor(b, this.roomShell);
    const glass = this.windowGlass ??= new THREE.MeshStandardMaterial({ color: WINDOW_LIGHT.day.glass, roughness: .78 });
    this.ownerWindow(b, glass);
    let windowIndex = 0;
    for (let x = -1; x < b.maxX - 2; x += 6, windowIndex++) {
      this.box(this.backWall, 3.65, 1.65, .09, x, 1.36, b.minZ + .15, '#c2dce9', .04).material = glass;
      this.box(this.backWall, .065, 1.5, .1, x, 1.36, b.minZ + .24, PALETTE.white, .015);
      this.box(this.backWall, 3.8, .12, .4, x, .55, b.minZ + .34, PALETTE.white, .03);
      // Blinds on every other window: thin slats whose own shading gives the wall depth.
      if (windowIndex % 2 === 1) for (let slat = 0; slat < 7; slat++) this.box(this.wallDecor ?? this.backWall, 3.5, .03, .02, x, 1.95 - slat * .15, b.minZ + .22, '#96acb5', 0);
    }
    this.wallFixtures(b);
    this.batchStaticMeshes(this.roomShell);
    if (this.wallDecor) this.batchStaticMeshes(this.wallDecor);
  }

  /** The owner's window left of the sign with a half-lowered blind; its pane and the floor light patch follow the local time. */
  private ownerWindow(b: ReturnType<typeof officeBounds>, glass: THREE.Material): void {
    const decor = this.wallDecor ?? this.backWall;
    this.box(this.backWall, 2.5, 1.25, .06, -12.4, 1.575, b.minZ + .13, PALETTE.white, .03);
    this.box(this.backWall, 2.24, 1.05, .06, -12.4, 1.575, b.minZ + .15, '#c2dce9', .02).material = glass;
    this.box(this.backWall, .06, 1.05, .08, -12.4, 1.575, b.minZ + .17, PALETTE.white, .015);
    this.box(this.backWall, 2.6, .08, .1, -12.4, .91, b.minZ + .15, PALETTE.white, .02);
    for (let slat = 0; slat < 5; slat++) this.box(decor, 2.24, .06, .02, -12.4, 2.07 - slat * .11, b.minZ + .2, '#96acb5', 0);
    this.box(decor, .012, .6, .012, -11.4, 1.8, b.minZ + .21, '#96acb5', 0);
    // The light patch on the floor belongs to the window, so it hides with the back wall.
    const patchMaterial = this.windowPatch ??= new THREE.MeshBasicMaterial({ color: WINDOW_LIGHT.day.patch, transparent: true,
      opacity: WINDOW_LIGHT.day.patchOpacity, depthWrite: false, side: THREE.DoubleSide });
    const near = -(b.minZ + .75), far = -(b.minZ + 2.45);
    const shape = new THREE.Shape([new THREE.Vector2(-13.4, near), new THREE.Vector2(-11.2, near), new THREE.Vector2(-10.4, far), new THREE.Vector2(-12.6, far)]);
    const patch = new THREE.Mesh(new THREE.ShapeGeometry(shape), patchMaterial);
    patch.name = 'window-light-patch';
    patch.rotation.x = -Math.PI / 2;
    patch.position.y = .03;
    patch.renderOrder = 1;
    this.backWall.add(patch);
  }

  /** A low open shelf and a cluster of pots in the front-right corner; they follow the room edge, clear of every aisle. */
  private rightStripDecor(b: ReturnType<typeof officeBounds>, parent: THREE.Object3D): void {
    const wood = PALETTE.wood, cx = b.maxX - .7, z0 = b.maxZ - 5.3, cz = b.maxZ - 3.8;
    this.box(parent, .5, .06, 3, cx, .03, cz, shadeHex(wood, .92), .02);
    for (const y of [.425, .845]) this.box(parent, .5, .05, 3, cx, y, cz, wood, .015);
    for (let divider = 0; divider <= 3; divider++) this.box(parent, .5, .87, .06, cx, .435, z0 + divider, wood, .015);
    const spines = [PALETTE.blue, PALETTE.lavender, PALETTE.peach, PALETTE.sage, PALETTE.yellow, PALETTE.mint];
    for (let cubby = 0; cubby < 3; cubby++) for (let level = 0; level < 2; level++) {
      const base = level ? .45 : .06;
      for (let book = 0; book < 3 + (cubby + level) % 2; book++) {
        const height = .28 + (book + cubby + level) % 3 * .03;
        this.box(parent, .34, height, .15, cx, base + height / 2, z0 + cubby + .14 + book * .19, spines[(book + cubby * 2 + level) % spines.length]!, .01);
      }
    }
    this.plant(cx, z0 + .45, .45, '#dfc7b4', .87, parent, 2);
    for (const [dx, dz, scale, pot, variant] of [[.75, 1.35, 1.35, '#d5ae91', 0], [1.55, .75, .9, '#dfc7b4', 2], [.55, .55, .6, '#dfc7b4', 1]] as const) {
      this.plant(b.maxX - dx, b.maxZ - dz, scale, pot, 0, parent, variant);
    }
  }

  /** Whiteboard, clock and bookshelf between the windows: static pieces merge in wallDecor, only the clock hands stay live. */
  private wallFixtures(b: ReturnType<typeof officeBounds>): void {
    const wall = this.wallDecor ?? this.backWall;
    const z = b.minZ + .12;
    // Whiteboard between the first two windows, with a few color strokes and no lettering.
    // Only when its widest piece (the tray, x 0.85~3.15) lies on the wall; the minimum room (maxX 3.6) always fits it.
    if (2 + 2.3 / 2 <= b.maxX) {
      this.box(wall, 2.2, 1.2, .04, 2, 1.55, z, PALETTE.white, .02);
      this.box(wall, 2.3, .05, .05, 2, .94, z + .01, '#c1cabc', .01);
      this.box(wall, .7, .05, .012, 1.5, 1.85, z + .03, PALETTE.blue, 0);
      this.box(wall, 1.0, .05, .012, 1.65, 1.65, z + .03, PALETTE.lavender, 0);
      this.box(wall, .5, .05, .012, 1.4, 1.45, z + .03, PALETTE.peach, 0);
      this.box(wall, .4, .4, .012, 2.6, 1.7, z + .03, PALETTE.yellow, .01);
    }
    // Wall clock over the corridor; hands follow the real time once a minute.
    const clock = this.cylinder(wall, .22, .22, .03, -4.7, 2.1, z, PALETTE.white, 20);
    clock.rotation.x = Math.PI / 2;
    const rim = this.mesh(new THREE.TorusGeometry(.22, .02, 6, 24), this.material('#96acb5'), wall, -4.7, 2.1, z + .01);
    rim.castShadow = false;
    const hour = this.box(this.backWall, .03, .12, .01, -4.7, 2.1, z + .025, PALETTE.dark, 0);
    const minute = this.box(this.backWall, .022, .17, .01, -4.7, 2.1, z + .03, PALETTE.dark, 0);
    for (const hand of [hour, minute]) { hand.geometry = hand.geometry.clone(); hand.geometry.translate(0, hand === hour ? .06 : .085, 0); hand.castShadow = false; }
    this.clockHands = { hour, minute };
    this.clockMinute = -1;
    // Bridge router between the clock and the first window: body and antennas merge with the wall decor, the LED stays live.
    this.box(wall, .54, .14, .14, -3.35, 1.49, z + .05, PALETTE.white, .03);
    for (const side of [-1, 1]) {
      const antenna = this.cylinder(wall, .012, .012, .32, -3.35 + side * .21, 1.72, z + .02, '#96acb5', 6);
      antenna.rotation.z = -side * .26;
      antenna.castShadow = false;
    }
    const quiet = STATUS_STYLE.idle.color;
    this.routerLedMaterial ??= new THREE.MeshStandardMaterial({ color: quiet, emissive: quiet, emissiveIntensity: .15, roughness: .5 });
    const led = this.sphere(this.backWall, .03, -3.2, 1.49, z + .125, quiet, 1, 1, 1, 10);
    led.material = this.routerLedMaterial;
    led.name = 'router-led';
    led.castShadow = false;
    this.routerLed = led;
    this.routerLedKey = '';
    this.updateRouterLed();
    // Bookshelf when the floor is wide enough for a second gap between windows.
    if (b.maxX >= 10) {
      this.box(wall, 2.2, 1.9, .3, 8, .95, z + .08, PALETTE.wood, .02);
      for (let shelf = 0; shelf < 3; shelf++) this.box(wall, 2.0, .48, .26, 8, .38 + shelf * .58, z + .1, '#f2efe5', .01);
      const spines = [PALETTE.blue, PALETTE.lavender, PALETTE.peach, PALETTE.sage, PALETTE.yellow, PALETTE.mint];
      for (let shelf = 0; shelf < 3; shelf++) for (let book = 0; book < 3 + shelf % 2; book++) {
        this.box(wall, .12 + (book % 2) * .04, .34 - (book % 3) * .04, .2, 7.2 + book * .19 + shelf * .05, .38 + shelf * .58, z + .1, spines[(book + shelf) % spines.length]!, .008);
      }
    }
  }

  /** `extra`: materials owned by removed objects but possibly attached to no mesh; they pass the same still-in-use filter. */
  private releaseRoomObjects(roots: THREE.Object3D[], pruneCache = false, keep: ReadonlySet<THREE.Material> = new Set(),
    extra: Iterable<THREE.Material> = []): void {
    const geometries = new Set<THREE.BufferGeometry>(pruneCache ? this.geometryCache.values() : []);
    const materials = new Set<THREE.Material>(extra);
    for (const root of roots) {
      root.removeFromParent();
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      });
    }
    // Batched rows and surviving people can share source geometry and palette materials.
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.delete(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.delete(material);
    });
    for (const material of this.materials.values()) materials.delete(material);
    // Per-figure layer materials outlive the parts that happened to use them.
    for (const material of keep) materials.delete(material);
    for (const [key, geometry] of this.geometryCache) if (geometries.has(geometry)) this.geometryCache.delete(key);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  private ensureCapacity(capacity: number, seatIds: readonly (string | undefined)[] = []): void {
    capacity = Math.max(1, Math.min(MAX_OFFICE_AGENTS + 1, capacity));
    const previousCapacity = this.figures.length;
    if (previousCapacity === capacity) return;
    const touched = new Set<THREE.Group>();
    if (previousCapacity > capacity) {
      const detached: THREE.Object3D[] = [], owned: THREE.Material[] = [];
      for (const figure of this.figures.splice(capacity)) {
        figure.deskWork?.dispose();
        detached.push(figure.group, figure.halo);
        // Layer and wrist materials belong to the figure even when its current look leaves them on no mesh.
        for (const material of [figure.trim, figure.cuff, figure.watchFace]) if (material) owned.push(material);
        figure.label.remove(); figure.bubble.remove();
        this.visibleBubbles.delete(figure.id);
      }
      const workers = capacity - 1;
      const rowCount = Math.ceil(workers / 5);
      const partialRow = workers % 5 ? rowCount - 1 : -2;
      for (const [row, fixtures] of this.fixtureRows) {
        if (row < 0 || row < rowCount && row !== partialRow) continue;
        detached.push(fixtures); this.fixtureRows.delete(row);
      }
      this.releaseRoomObjects(detached, false, undefined, owned);
      if (partialRow >= 0) {
        const fixtures = new THREE.Group();
        fixtures.name = `desks-row-${partialRow}`;
        this.world.add(fixtures); this.fixtureRows.set(partialRow, fixtures);
        for (let index = partialRow * 5 + 1; index < capacity; index++) {
          const seat = seatPosition(index);
          this.workstation(seat.x, seat.z, index, fixtures);
        }
        touched.add(fixtures);
      }
    }
    for (let index = this.figures.length; index < capacity; index++) {
      const row = index === 0 ? -1 : Math.floor((index - 1) / 5);
      let fixtures = this.fixtureRows.get(row);
      if (!fixtures) { fixtures = new THREE.Group(); fixtures.name = `desks-row-${row}`; this.world.add(fixtures); this.fixtureRows.set(row, fixtures); }
      const seat = seatPosition(index);
      if (index === 0) {
        fixtures.position.set(seat.x, 0, seat.z);
        fixtures.rotation.y = Math.PI;
        this.workstation(0, 0, index, fixtures);
      } else this.workstation(seat.x, seat.z, index, fixtures);
      const figure = this.createFigure(index, seatIds[index]);
      this.figures.push(figure);
      figure.group.visible = false; figure.halo.visible = false; figure.label.style.display = 'none';
      figure.bubble.style.display = 'none';
      touched.add(fixtures);
    }
    for (const figure of this.figures) {
      const screen = this.world.getObjectByName(`screen-${figure.seat}`);
      if (screen instanceof THREE.Mesh) figure.screen = screen;
    }
    for (const fixtures of touched) this.batchStaticMeshes(fixtures);
    if (!this.farFigures) this.buildOverviewInstances();
    if (this.farFigures) this.farFigures.count = this.figures.length;
    if (this.farDesks) this.farDesks.count = this.figures.length;
    const previous = this.bounds;
    this.bounds = officeBounds(capacity);
    if (previous.depth !== this.bounds.depth || previous.width !== this.bounds.width) this.rebuildShell();
    if (previousCapacity > capacity) this.releaseRoomObjects([], true);
    const abandonedPan = previousCapacity > capacity && this.manualProjectionBase !== undefined
      && (this.targetGoal.x < this.bounds.minX || this.targetGoal.x > this.bounds.maxX
        || this.targetGoal.z < this.bounds.minZ || this.targetGoal.z > this.bounds.maxZ);
    if (!this.following && !this.buildingView && (abandonedPan || this.manualProjectionBase === undefined && !this.focusId)) {
      // Keep a chosen scale and direction, but do not leave the camera over removed rear desks.
      if (abandonedPan && capacity > 1) {
        this.targetGoal.set(0, 0, 0);
        for (const figure of this.figures.slice(1)) this.targetGoal.add(figure.origin);
        this.targetGoal.multiplyScalar(1 / (capacity - 1)).y = .3;
      } else this.targetGoal.set(this.bounds.centerX, .3, this.bounds.centerZ);
    }
    this.resize();
  }

  private buildOverviewInstances(): void {
    const head = new THREE.SphereGeometry(.43, 8, 6).translate(0, 1.96, 0);
    const body = new THREE.SphereGeometry(.43, 8, 6).scale(.95, 1.1, .8).translate(0, 1.25, 0);
    const person = mergeGeometries([head, body])!;
    head.dispose(); body.dispose();
    this.farFigures = new THREE.InstancedMesh(person, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 }), MAX_OFFICE_AGENTS + 1);
    this.farFigures.name = 'distant-employees';
    this.farFigures.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.farFigures.frustumCulled = false;
    this.world.add(this.farFigures);
    const top = new THREE.BoxGeometry(3.65, .18, 1.55).translate(0, 1.17, -1.12);
    const pedestal = new THREE.BoxGeometry(.3, 1.1, .3).translate(0, .55, -1.12);
    const monitor = new THREE.BoxGeometry(1.15, .8, .13).translate(-.22, 1.9, -1.33);
    const desk = mergeGeometries([top, pedestal, monitor])!;
    top.dispose(); pedestal.dispose(); monitor.dispose();
    this.farDesks = new THREE.InstancedMesh(desk, new THREE.MeshStandardMaterial({ color: '#dbe8e9', roughness: 1 }), MAX_OFFICE_AGENTS + 1);
    this.farDesks.name = 'distant-desks';
    this.farDesks.frustumCulled = false;
    this.world.add(this.farDesks);
  }

  private updateDetailLevels(): void {
    if (!this.farFigures || !this.farDesks) return;
    const pixelsPerUnit = this.container.clientHeight / (this.camera.top - this.camera.bottom);
    const furnitureDetailed = pixelsPerUnit * 3.65 >= 8;
    const visibleCount = this.visibleFigureCount();
    for (const row of this.fixtureRows.values()) row.visible = furnitureDetailed;
    const matrix = new THREE.Matrix4();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const figure of this.figures) {
      const detailed = figure.group.visible && (visibleCount <= 30 || figure.id === this.focusId
        || pixelsPerUnit > 9 && figure.group.position.distanceTo(this.cameraTarget) < 16);
      if (figure.detail) {
        // A body returning to detail places its phone before it is drawn.
        if (detailed && !figure.detail.visible && figure.phone) this.placePhone(figure);
        figure.detail.visible = detailed;
      }
      figure.screen.visible = furnitureDetailed && this.agentSeats.get(figure.id) === figure.seat;
      // An open card leaves only the bubble and the selection ring, so the status halo under the person steps aside too.
      figure.halo.visible = detailed && figure.group.visible && !this.cardHidesMarkers(figure);
      matrix.compose(figure.group.position, figure.group.quaternion, figure.group.scale);
      this.farFigures.setMatrixAt(figure.seat, !figure.group.visible || detailed ? hidden : matrix);
      this.farFigures.setColorAt(figure.seat, figure.shirt.color);
      matrix.makeRotationY(figure.seat === 0 ? Math.PI : 0);
      matrix.setPosition(figure.origin.x, 0, figure.origin.z);
      this.farDesks.setMatrixAt(figure.seat, furnitureDetailed ? hidden : matrix);
    }
    this.farFigures.instanceMatrix.needsUpdate = true;
    this.farFigures.boundingSphere = null;
    if (this.farFigures.instanceColor) this.farFigures.instanceColor.needsUpdate = true;
    this.farDesks.instanceMatrix.needsUpdate = true;
  }

  private workstation(x: number, z: number, index: number, parent: THREE.Object3D = this.world): void {
    const deskZ = z - 1.12;
    const legColor = index === 0 ? '#78998a' : '#f2efe5';
    this.box(parent, 3.65, .18, 1.55, x, 1.17, deskZ, index === 0 ? '#d9b98e' : '#f4f0e5', .085).name = `desk-top-${index}`;
    this.box(parent, 3.57, .07, 1.49, x, 1.055, deskZ, '#d5cdbb', .025);
    for (const dx of [-1.43, 1.43]) {
      this.box(parent, .13, 1.02, .13, x + dx, .52, deskZ + .49, legColor, .025);
      this.box(parent, .13, 1.02, .13, x + dx, .52, deskZ - .49, legColor, .025);
      this.box(parent, .15, .08, 1.26, x + dx, .08, deskZ, legColor, .025);
    }
    // Computer: rounded body, glowing inset display and tiny editor / card UI.
    this.box(parent, 1.15, .8, .13, x - .22, 1.9, deskZ - .21, PALETTE.dark, .065);
    const screen = this.box(parent, 1.025, .66, .018, x - .22, 1.9, deskZ - .132, '#d3e8d9', .022);
    screen.material = new THREE.MeshStandardMaterial({ color: '#d0e5db', emissive: '#aecfc4', emissiveIntensity: .25, roughness: .55 });
    screen.name = `screen-${index}`;
    this.box(parent, .11, .29, .11, x - .22, 1.42, deskZ - .2, PALETTE.dark, .02);
    this.box(parent, .57, .04, .32, x - .22, 1.29, deskZ - .2, PALETTE.dark, .04);
    this.box(parent, .19, .48, .014, x - .6, 1.91, deskZ - .112, '#a1c3b6', .012);
    for (let line = 0; line < 4; line++) {
      this.box(parent, .38 + ((index + line) % 3) * .06, .036, .012,
        x - .11, 2.08 - line * .112, deskZ - .11, line === 0 ? '#679b8c' : '#9abbad', .01);
    }
    // A warm desk mat grounds small objects and makes each department distinct.
    this.box(parent, 1.65, .016, .51, x - .14, 1.275, deskZ + .43, index === 0 ? '#78998a' : '#cbd5c7', .055);
    this.box(parent, .94, .06, .31, x - .26, 1.316, deskZ + .43, '#fbf9ee', .03);
    for (let row = 0; row < 3; row++) for (let key = 0; key < 9; key++) {
      this.box(parent, .067, row === 1 ? .017 : .013, .057, x - .63 + key * .094, 1.353, deskZ + .345 + row * .08, '#d9ded1', .007);
    }
    // Mouse: a low dome with a wheel and a groove instead of a bare sphere.
    this.sphere(parent, .11, x + .63, 1.32, deskZ + .44, '#f8f6ec', .65, .34, 1);
    this.box(parent, .02, .02, .04, x + .63, 1.355, deskZ + .41, PALETTE.dark, .006);
    this.box(parent, .006, .01, .09, x + .63, 1.352, deskZ + .47, PALETTE.dark, 0);
    this.box(parent, .3, .013, .057, x - .26, 1.353, deskZ + .585, '#d9ded1', .007);
    this.cup(x + 1.25, 1.285, deskZ + .33, seatPosition(index).color, parent);
    // Employees keep a document folder; the owner's documents live in the approval tray instead.
    if (index !== 0) {
      this.box(parent, .53, .07, .72, x - 1.2, 1.305, deskZ + .12, index % 2 ? PALETTE.lavender : PALETTE.yellow, .03).rotation.y = -.12;
      this.box(parent, .47, .025, .66, x - 1.19, 1.355, deskZ + .12, PALETTE.white, .01).rotation.y = -.12;
      this.box(parent, .034, .034, .5, x - 1.13, 1.395, deskZ + .11, '#8b9e87', .008).rotation.y = -.18;
    }
    this.plant(x + 1.32, deskZ - .36, .31, '#dfc7b4', 1.285, parent, index % 3);
    // Storage under each desk with three little finger pulls.
    this.box(parent, .62, .81, .86, x - 1.18, .43, deskZ + .03, '#d6ddcf', .055);
    for (let i = 0; i < 3; i++) {
      this.box(parent, .55, .225, .035, x - 1.18, .2 + i * .245, deskZ + .48, '#e7e9dc', .025);
      this.box(parent, .14, .022, .04, x - 1.18, .245 + i * .245, deskZ + .511, '#9aa994', .008);
    }
    // The chair stays behind when its employee walks over to another department.
    this.cylinder(parent, .09, .09, .53, x, .34, z + .08, '#8d9a8a', 12);
    for (let i = 0; i < 5; i++) {
      const angle = i * Math.PI * 2 / 5;
      const spoke = this.box(parent, .08, .07, .66, x + Math.sin(angle) * .22, .12, z + .08 + Math.cos(angle) * .22, '#99a793', .02);
      spoke.rotation.y = angle;
      this.sphere(parent, .07, x + Math.sin(angle) * .51, .07, z + .08 + Math.cos(angle) * .51, '#7d8d7d');
    }
    const seatColor = index === 0 ? OWNER_CHAIR.seat : seatPosition(index).color;
    const backColor = index === 0 ? OWNER_CHAIR.back : seatPosition(index).color;
    this.box(parent, .97, .2, .9, x, .7, z + .08, seatColor, .13).name = `chair-seat-${index}`;
    const backHeight = index === 0 ? 1.1 : .86;
    const backY = 1.17 + (backHeight - .86) / 2;
    this.box(parent, .97, backHeight, .17, x, backY, z + .48, backColor, .13).name = `chair-back-${index}`;
    this.box(parent, .8, index === 0 ? .9 : .66, .07, x, backY, z + .375, index === 0 ? shadeHex(OWNER_CHAIR.back, 1.12) : '#d8dfcd', .12);
    // Quilted stitching on the owner's leather back cushion.
    if (index === 0) for (const dy of [-.22, 0, .22]) this.box(parent, .66, .014, .012, x, backY + dy, z + .334, shadeHex(OWNER_CHAIR.back, .9), 0);
    // Armrests in the seat tone, a headrest for the owner only.
    const armrest = shadeHex(seatColor, .92);
    for (const dx of [-.5, .5]) {
      this.box(parent, .09, .05, .5, x + dx, 1.02, z + .1, armrest, .02);
      this.box(parent, .06, .3, .06, x + dx, .85, z + .1, armrest, .015);
    }
    if (index === 0) this.box(parent, .5, .18, .14, x, 1.93, z + .5, backColor, .06);
    this.deskProps(x, deskZ, index, parent);
  }

  /** Static desk and floor items chosen by seat variation, all merged with the furniture. */
  private deskProps(x: number, deskZ: number, index: number, parent: THREE.Object3D): void {
    const variation = index % 6;
    // Sticky notes beside the display.
    if (variation === 1 || variation === 2 || variation === 4) {
      const notes = [PALETTE.yellow, PALETTE.mint, PALETTE.peach];
      for (let i = 0; i < 2 + variation % 2; i++) {
        this.box(parent, .09, .09, .008, x + .42, 2.02 - i * .11, deskZ - .135, notes[(i + variation) % 3]!, 0).rotation.z = (i % 2 ? -.1 : .1);
      }
    }
    // A small frame with three color shapes, no photo texture.
    if (variation === 1 || variation === 3 || variation === 4) {
      this.box(parent, .22, .18, .02, x + .95, 1.36, deskZ - .4, PALETTE.wood, .008).rotation.y = .3;
      this.box(parent, .17, .13, .01, x + .95, 1.36, deskZ - .385, PALETTE.cream, 0).rotation.y = .3;
      this.sphere(parent, .03, x + .91, 1.38, deskZ - .375, PALETTE.peach, 1, 1, 1, 8);
      this.sphere(parent, .03, x + .98, 1.37, deskZ - .372, PALETTE.blue, 1, 1, 1, 8);
    }
    // Water bottle in an opaque pale blue so it still merges with the furniture.
    if (variation === 2 || variation === 5) {
      this.cylinder(parent, .06, .06, .34, x + 1.02, 1.435, deskZ + .1, '#c2dce9', 12);
      this.cylinder(parent, .035, .045, .06, x + 1.02, 1.635, deskZ + .1, PALETTE.blue, 10);
    }
    // Desk lamp base and arm; the glow lives on the figure so it can react to reading.
    if (variation === 0 || variation === 3) {
      this.box(parent, .18, .03, .18, x + .95, 1.28, deskZ - .45, '#8d9a8a', .01);
      const arm = this.cylinder(parent, .015, .015, .5, x + .95, 1.55, deskZ - .45, '#8d9a8a', 6);
      arm.rotation.z = .12;
      const shade = this.mesh(new THREE.CylinderGeometry(0, .12, .14, 12), this.material(PALETTE.sage), parent, x + .95, 1.86, deskZ - .45);
      shade.rotation.z = .12;
    }
    // Headset stand for the seat with headphones.
    if (variation === 4) {
      this.box(parent, .14, .02, .14, x + 1.0, 1.275, deskZ - .35, '#d6ddcf', .008);
      this.cylinder(parent, .02, .02, .34, x + 1.0, 1.45, deskZ - .35, '#d6ddcf', 8);
      this.box(parent, .16, .04, .06, x + 1.0, 1.63, deskZ - .35, '#d6ddcf', .015);
    }
    // Bin beside the drawers, with one crumpled page.
    this.cylinder(parent, .1, .08, .24, x + 1.7, .12, deskZ + .55, '#d6ddcf', 12);
    this.sphere(parent, .045, x + 1.7, .26, deskZ + .55, PALETTE.white, 1, .8, 1, 8);
    if (index === 0) {
      // Owner's desk: a nameplate facing visitors, a stamp stand, and an approval tray whose sheets count current requests.
      this.box(parent, .74, .2, .12, x - 1.27, 1.36, deskZ - .57, PALETTE.dark, .01);
      this.box(parent, .3, .05, .26, x + .6, 1.285, deskZ - .54, shadeHex(PALETTE.wood, .9), .012);
      this.cylinder(parent, .045, .05, .17, x + .6, 1.395, deskZ - .54, PALETTE.peach, 10);
      this.sphere(parent, .06, x + .6, 1.52, deskZ - .54, PALETTE.peach, 1, 1, 1, 10);
      this.cylinder(parent, .055, .055, .03, x + .34, 1.275, deskZ - .54, '#ff5b54', 12);
      const trayX = x + 1.5, trayZ = deskZ - .05;
      // A wood base, so the white sheets that count current requests read against the tray.
      this.box(parent, .5, .04, .4, trayX, 1.28, trayZ, shadeHex(PALETTE.wood, .9), .01);
      for (const dz of [-.19, .19]) this.box(parent, .5, .06, .02, trayX, 1.31, trayZ + dz, PALETTE.yellow, .006);
      for (const dx of [-.24, .24]) this.box(parent, .02, .06, .4, trayX + dx, 1.31, trayZ, PALETTE.yellow, .006);
      const live = new THREE.Group();
      live.name = 'owner-desk-live';
      parent.add(live);
      this.ownerDeskLive = live;
      // Prepared sheets only toggle visibility, so a changing request count never builds geometry or materials.
      const sheets = Array.from({ length: 6 }, (_, sheet) => {
        const mesh = this.box(live, .42, .012, .3, trayX, 1.306 + sheet * .015, trayZ, PALETTE.white, 0);
        mesh.name = 'owner-approval-sheet';
        mesh.rotation.y = (sheet % 2 ? .05 : -.04) + sheet * .008;
        mesh.castShadow = false;
        mesh.visible = false;
        return mesh;
      });
      const clip = this.box(live, .1, .045, .05, trayX, 1.306 + 5 * .015 + .02, trayZ + .15, PALETTE.dark, .01);
      clip.name = 'owner-approval-clip';
      clip.visible = false;
      this.approvalPile = { sheets, clip, count: -1 };
      this.syncApprovalPile();
      const lettering = this.createLettering('nameplate', live, .66, .145, x - 1.27, 1.36, deskZ - .64);
      if (lettering) lettering.rotation.y = Math.PI;
    }
  }

  private createFigure(index: number, agentId?: string): AgentFigure {
    const seat = seatPosition(index);
    // The person's look follows their id; an unassigned figure wears its seat id's look until someone sits there.
    const lookId = agentId ?? seat.id;
    const appearance = appearanceFor(lookId);
    const group = new THREE.Group();
    group.position.set(seat.x, 0, seat.z);
    const homeYaw = index === 0 ? 0 : Math.PI;
    group.rotation.y = homeYaw;
    this.world.add(group);
    // Desk furniture (the lamp and mug) stays with the seat.
    const deskVariation = index % 6;
    const shirt = new THREE.MeshStandardMaterial({ color: appearance.seatShirt, roughness: .93 });
    // Layers over the shirt follow this person's model color: derived per figure, never shared through the cache.
    const trim = new THREE.MeshStandardMaterial({ color: shadeHex(appearance.seatShirt, .92), roughness: .93 });
    const cuff = new THREE.MeshStandardMaterial({ color: shadeHex(appearance.seatShirt, .9), roughness: .93 });
    const skin: THREE.Mesh[] = [];
    const shoes: THREE.Mesh[] = [];
    const soles: THREE.Mesh[] = [];
    const bossOnly: THREE.Object3D[] = [];
    const trouser = appearance.isBoss ? OWNER_LOOK.jeans : EMPLOYEE_LOOK.pants;
    const torso = this.sphere(group, .43, 0, 1.26, 0, appearance.seatShirt, .93, 1.07, .72);
    torso.material = shirt;
    const pelvis = this.box(group, .49, .31, .49, 0, .955, 0, trouser, .1);
    pelvis.name = 'employee-pelvis';
    const pants: THREE.Mesh[] = [pelvis];
    const chairSeat = this.world.getObjectByName(`chair-seat-${index}`);
    pelvis.geometry.computeBoundingBox();
    // Rounded furniture has bevels; align the actual surfaces, not just nominal dimensions.
    if (chairSeat && pelvis.geometry.boundingBox) {
      pelvis.position.y = new THREE.Box3().setFromObject(chairSeat).max.y - pelvis.geometry.boundingBox.min.y;
    }
    skin.push(this.cylinder(group, .13, .13, .18, 0, 1.65, 0, appearance.skin));
    const head = new THREE.Group();
    head.position.y = 1.96;
    group.add(head);
    skin.push(this.sphere(head, .43, 0, 0, 0, appearance.skin, 1, 1.06, .96));
    skin.push(this.sphere(head, .107, -.4, -.01, 0, appearance.skin, .6, 1, .7));
    skin.push(this.sphere(head, .107, .4, -.01, 0, appearance.skin, .6, 1, .7));
    const eyes: THREE.Mesh[] = [];
    for (const eyeX of [-.155, .155]) {
      const eye = this.sphere(head, .042, eyeX, .012, .385, '#3d4037', 1, 1.13, .5);
      eye.name = eyeX < 0 ? 'employee-eye-left' : 'employee-eye-right';
      eyes.push(eye);
      this.sphere(head, .012, eyeX - .009, .025, .405, '#fffdf3');
      this.sphere(head, .065, eyeX * 1.38, -.103, .356, '#e6a291', 1, .48, .2);
    }
    skin.push(this.sphere(head, .045, 0, -.04, .409, appearance.skin, .85, .8, .7));
    const smile = this.mesh(new THREE.TorusGeometry(.056, .011, 5, 12, Math.PI), this.material('#9a6857'), head, 0, -.104, .397);
    smile.rotation.z = Math.PI;
    const yawnMouth = this.sphere(head, .067, 0, -.104, .398, '#996f66', .65, 1.25, .22);
    yawnMouth.name = 'employee-yawn-mouth';
    yawnMouth.visible = false;
    // Expression set: two brows, three extra mouths and a sweat drop; only one mouth shows at a time.
    const brows: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const brow = this.box(head, .09, .018, .02, side * .155, .11, .395, appearance.hair, .008);
      brow.castShadow = false;
      brows.push(brow);
    }
    const mouthLine = this.box(head, .09, .014, .012, 0, -.104, .4, '#9a6857', 0);
    mouthLine.visible = false; mouthLine.castShadow = false;
    const mouthOpen = this.sphere(head, .045, 0, -.108, .4, '#996f66', .8, 1.1, .3, 10);
    mouthOpen.visible = false; mouthOpen.castShadow = false;
    const mouthWave = new THREE.Group();
    mouthWave.position.set(0, -.104, .4);
    head.add(mouthWave);
    for (const [dx, flip] of [[-.028, 0], [.028, Math.PI]] as const) {
      const wave = this.mesh(new THREE.TorusGeometry(.028, .008, 4, 8, Math.PI), this.material('#9a6857'), mouthWave, dx, 0, 0);
      wave.rotation.z = flip; wave.castShadow = false;
    }
    mouthWave.visible = false;
    const sweat = this.sphere(head, .028, .3, .12, .3, PALETTE.blue, 1, 1.4, 1, 8);
    sweat.visible = false; sweat.castShadow = false;
    const arm = (side: number): THREE.Group => {
      const pivot = new THREE.Group();
      pivot.position.set(side * .34, 1.4, .01);
      group.add(pivot);
      const sleeve = this.sphere(pivot, .15, side * .04, -.14, .05, appearance.seatShirt, .8, 1.6, .9);
      sleeve.material = shirt;
      const hand = this.sphere(pivot, .105, side * .035, -.33, .13, appearance.skin, 1, 1.05, 1);
      hand.name = 'employee-hand';
      // Thumb and a finger ridge turn the sphere into a hand; the cuff separates sleeve from skin.
      const thumb = this.sphere(pivot, .042, side * -.06, -.31, .19, appearance.skin, 1, 1, 1, 8);
      thumb.castShadow = false;
      const ridge = this.box(pivot, .14, .03, .07, side * .04, -.395, .19, appearance.skin, .012);
      ridge.castShadow = false;
      skin.push(hand, thumb, ridge);
      const cuffRing = this.mesh(new THREE.TorusGeometry(.11, .022, 6, 14), cuff, pivot, side * .03, -.22, .09);
      cuffRing.rotation.x = Math.PI / 2;
      cuffRing.castShadow = false;
      pivot.rotation.x = -1.12;
      return pivot;
    };
    const leg = (side: number): { thigh: THREE.Group; knee: THREE.Group } => {
      const pivot = new THREE.Group();
      pivot.position.set(side * .19, .88, 0);
      group.add(pivot);
      pants.push(this.box(pivot, .22, .32, .25, 0, -.16, 0, trouser, .065));
      const knee = new THREE.Group();
      knee.position.y = -.32;
      pivot.add(knee);
      pants.push(this.box(knee, .205, .38, .23, 0, -.19, 0, trouser, .06));
      const sock = this.box(knee, .24, .03, .25, 0, -.335, 0, PALETTE.white, .01);
      sock.name = 'employee-sock'; sock.castShadow = false;
      if (appearance.isBoss) {
        // A rolled jeans hem over the sock and a yellow outer seam; hidden if this body ever wears another look.
        const hem = this.box(knee, .25, .065, .27, 0, -.335, 0, OWNER_LOOK.hem, .02);
        hem.name = 'owner-jeans-hem'; hem.castShadow = false;
        const seam = this.box(knee, .012, .26, .012, side * .106, -.17, 0, OWNER_LOOK.stitch, 0);
        seam.castShadow = false;
        bossOnly.push(hem, seam);
      }
      const shoe = this.box(knee, .23, .17, .39, 0, -.43, .09, appearance.isBoss ? OWNER_LOOK.sneaker : EMPLOYEE_LOOK.shoe, .065);
      shoe.name = 'employee-shoe';
      shoes.push(shoe);
      soles.push(this.box(knee, .23, .047, .39, 0, -.52, .09, appearance.isBoss ? OWNER_LOOK.sole : EMPLOYEE_LOOK.sole, .022));
      pivot.rotation.x = -Math.PI / 2;
      knee.rotation.x = Math.PI / 2;
      return { thigh: pivot, knee };
    };
    const leftArm = arm(-1);
    const rightArm = arm(1);
    const dressed = this.buildLook(group, head, leftArm, appearance, trim, cuff);
    const approvalStamp = index === 0 ? new THREE.Group() : undefined;
    if (approvalStamp) {
      approvalStamp.name = 'owner-approval-stamp';
      approvalStamp.position.set(.035, -.38, .13);
      this.cylinder(approvalStamp, .075, .095, .18, 0, -.045, 0, '#a76e62', 12);
      this.box(approvalStamp, .26, .06, .22, 0, -.165, 0, '#734f52', .025);
      rightArm.add(approvalStamp);
      approvalStamp.visible = false;
    }
    // The owner files a finished visit's sheet into the tray with the left hand; it shows only during that gesture.
    const handSheet = index === 0 ? new THREE.Group() : undefined;
    if (handSheet) {
      handSheet.name = 'owner-hand-sheet';
      handSheet.position.set(-.03, -.42, .2);
      handSheet.rotation.x = -.35;
      this.box(handSheet, .3, .012, .22, 0, 0, 0, PALETTE.white, 0).castShadow = false;
      leftArm.add(handSheet);
      handSheet.visible = false;
    }
    const left = leg(-1);
    const right = leg(1);
    const leftLeg = left.thigh;
    const rightLeg = right.thigh;
    const leftKnee = left.knee;
    const rightKnee = right.knee;
    const halo = this.mesh(new THREE.RingGeometry(.76, .82, 48),
      new THREE.MeshStandardMaterial({ color: '#9fb9a8', transparent: true, opacity: .45, side: THREE.DoubleSide, roughness: .9 }),
      this.world, seat.x, .035, seat.z);
    halo.rotation.x = -Math.PI / 2;
    halo.castShadow = false;
    const signal = new THREE.Group();
    signal.position.set(.64, 2.43, .04);
    group.add(signal);
    for (let i = 0; i < 3; i++) {
      const dot = this.sphere(signal, .058, i * .145, 0, 0, '#9ab8a6');
      dot.material = new THREE.MeshStandardMaterial({ color: '#9ab8a6', roughness: .65 });
      dot.castShadow = false;
    }
    signal.visible = false;
    const paper = new THREE.Group();
    paper.position.set(.49, 1.42, .2);
    paper.rotation.set(-.14, .06, -.18);
    group.add(paper);
    this.box(paper, .4, .51, .055, 0, 0, 0, '#eac778', .025);
    this.box(paper, .35, .46, .022, 0, .025, .045, '#fffdf2', .015);
    this.box(paper, .18, .045, .018, -.025, .15, .063, '#a8bbae', .008);
    for (let i = 0; i < 3; i++) this.box(paper, .24, .018, .018, 0, .05 - i * .07, .063, '#d5dacc', .006);
    paper.visible = false;
    // Desk items that react to status ride on the figure so distance LOD hides them with the rest of the detail.
    // Workstation offsets (dx, dz) from the seat map to figure-local (-dx, y, -dz) for employees and the owner alike.
    const steamMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.white, transparent: true, opacity: 0, roughness: 1, depthWrite: false });
    const steam: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const puff = this.sphere(group, .035, -1.25 + (i - 1) * .04, 1.62, .79, PALETTE.white, 1, 1, 1, 8);
      puff.material = steamMaterial;
      puff.castShadow = false;
      puff.visible = false;
      steam.push(puff);
    }
    const quiet = STATUS_STYLE.idle.color;
    const led = this.sphere(group, .02, -.32, 1.53, 1.255, quiet, 1, 1, 1, 8);
    led.material = new THREE.MeshStandardMaterial({ color: quiet, emissive: quiet, emissiveIntensity: .5, roughness: .6 });
    led.castShadow = false;
    let lampGlow: THREE.Mesh | undefined;
    if (deskVariation === 0 || deskVariation === 3) {
      lampGlow = this.sphere(group, .07, -.95, 1.98, 1.57, '#fff9e9', 1, .6, 1, 8);
      lampGlow.material = new THREE.MeshStandardMaterial({ color: '#fff9e9', emissive: '#fff9e9', emissiveIntensity: .2, roughness: 1 });
      lampGlow.castShadow = false;
      lampGlow.visible = false;
    }
    // A mug that appears in the hand during a sip; the desk mug stays merged with the furniture.
    const handMug = new THREE.Group();
    handMug.position.set(.03, -.46, .2);
    handMug.visible = false;
    this.cup(0, 0, 0, seat.color, handMug);
    rightArm.add(handMug);
    const label = document.createElement('div');
    label.setAttribute('aria-hidden', 'true');
    label.className = 'office-scene-name';
    Object.assign(label.style, {
      position: 'absolute', left: '0', top: '0', display: 'flex', alignItems: 'center', gap: '5px',
      padding: '4px 8px', borderRadius: '20px', background: 'rgba(238,245,250,.94)',
      border: '1px solid rgba(125,150,168,.27)', color: '#31495e',
      font: '600 11px/1.2 Pretendard, -apple-system, BlinkMacSystemFont, sans-serif',
      whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(49,73,94,.07)', pointerEvents: 'none',
      userSelect: 'none', willChange: 'transform', zIndex: '2',
    });
    const labelDot = document.createElement('span');
    Object.assign(labelDot.style, { width: '5px', height: '5px', borderRadius: '50%', background: quiet });
    const labelName = document.createElement('span');
    labelName.textContent = ['사장님', '모아', '노바', '루미', '코디', '체키'][index] ?? seat.id;
    label.append(labelDot, labelName);
    this.container.append(label);
    const bubble = document.createElement('div');
    bubble.className = 'office-activity-bubble';
    bubble.setAttribute('aria-hidden', 'true');
    Object.assign(bubble.style, {
      position: 'absolute', left: '0', top: '0', display: 'none', height: `${ACTIVITY_BUBBLE_HEIGHT}px`,
      boxSizing: 'border-box', pointerEvents: 'none', userSelect: 'none', zIndex: '3', willChange: 'transform',
    });
    const bubbleContent = document.createElement('span');
    Object.assign(bubbleContent.style, { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    bubble.append(bubbleContent);
    this.container.append(bubble);
    const activity = activityMessage({ status: 'idle' });
    // Employees keep a phone on the desk, inside the detail LOD; the owner never uses one.
    const phone = index === 0 ? undefined : this.buildPhone(group);
    const detail = new THREE.Group();
    for (const child of [...group.children]) detail.add(child);
    group.add(detail);
    return { id: seat.id, group, detail, approvalStamp, handSheet, head, leftArm, rightArm, leftLeg, rightLeg, leftKnee, rightKnee,
      yawnStartedAt: null, nextYawnAt: this.elapsed + idleYawnDelay(seat.id), yawnCycle: 0, yawnMouth, smile, eyes,
      trim, cuff, torso, brows, mouthLine, mouthOpen, mouthWave, sweat, ponytail: dressed.ponytail, watchFace: dressed.watchFace,
      handMug, steam, lampGlow, led, hasWatch: dressed.hasWatch, phone,
      look: { agentId: lookId, key: appearanceKey(appearance), parts: dressed.parts, skin, hair: [...brows], shoes, pants, soles, bossOnly },
      expression: 'idle', expressionSince: -1, blinkStartedAt: null, nextBlinkAt: this.elapsed + actionDelay(seat.id, 'blink', 0, 3, 3),
      reachStartedAt: null, nextReachAt: this.elapsed + actionDelay(seat.id, 'reach', 0, 12, 8),
      flipStartedAt: null, nextFlipAt: this.elapsed + actionDelay(seat.id, 'flip', 0, 8, 6),
      tapStartedAt: null, nextTapAt: this.elapsed + actionDelay(seat.id, 'tap', 0, 10, 8),
      sipStartedAt: null, nextSipAt: this.elapsed + actionDelay(seat.id, 'sip', 0, 40, 30),
      glanceStartedAt: null, nextGlanceAt: this.elapsed + actionDelay(seat.id, 'glance', 0, 6, 3), actionCycle: 0,
      doneAt: -Infinity, bowUntil: 0, nodUntil: 0, lookYaw: null, catchUntil: 0, pushUntil: 0,
      activity, bubble, bubbleContent, bubbleWidth: activityBubbleWidth(activity.text, false), compactBubbleWidth: activityBubbleWidth(activity.compactText, true),
      nameWidth: 180,
      screen: this.world.getObjectByName(`screen-${index}`) as THREE.Mesh,
      halo, signal, paper, origin: group.position.clone(), shirt, status: 'idle', phase: index * 1.7, seat: index, homeYaw, label };
  }

  /**
   * Hair, headwear, glasses, clothing layers and wrist accessories of one look. Every root is recorded so a reused
   * figure can exchange them in place; skin, brows and shoes are persistent meshes that only change material.
   */
  private buildLook(body: THREE.Object3D, head: THREE.Object3D, leftArm: THREE.Object3D, look: Appearance,
    trim: THREE.MeshStandardMaterial, cuff: THREE.MeshStandardMaterial,
  ): { parts: THREE.Object3D[]; ponytail?: THREE.Group; hasWatch: boolean; watchFace?: THREE.MeshStandardMaterial } {
    const parts: THREE.Object3D[] = [];
    const part = <T extends THREE.Object3D>(object: T): T => { parts.push(object); return object; };
    const layer = (mesh: THREE.Mesh): THREE.Mesh => { mesh.material = trim; mesh.castShadow = false; return part(mesh); };
    const { variation, hair, seatShirt: shirt, headwear, outfit } = look;
    const smallCap = headwear === 'small-cap';
    // Six silhouettes: cap with bangs, buns, curls, ponytail, small cap or beanie.
    if (headwear !== 'curly' && headwear !== 'beanie') {
      const cap = part(this.mesh(new THREE.SphereGeometry(.45, 18, 12, 0, Math.PI * 2, 0, Math.PI * .57), this.material(hair), head, 0, .075, -.025));
      cap.rotation.x = -.2;
      if (smallCap) { cap.scale.set(.88, 1, .9); cap.position.y = .11; }
    }
    if (headwear !== 'curly') for (let i = 0; i < (smallCap ? 2 : 4); i++) {
      part(this.sphere(head, .135, -.28 + i * .17 + (smallCap ? .17 : 0), .22 + Math.sin(i + variation) * .055, .29, hair, 1, .78, .8));
    }
    if (headwear === 'curly') {
      // Short curls: a cluster of spheres instead of the cap, so the round silhouette reads from behind too.
      for (let i = 0; i < 9; i++) {
        const angle = i * 2.4;
        part(this.sphere(head, .16, Math.sin(angle) * .3, .2 - i * .028, Math.cos(angle) * .3 - .02, hair, 1, .9, 1, 10));
      }
      part(this.sphere(head, .2, 0, .34, -.02, hair, 1, .8, 1, 10));
    }
    if (headwear === 'buns') {
      for (const side of [-1, 1]) part(this.sphere(head, .19, side * .36, -.08, -.28, hair, .9, 1, .9, 12));
    }
    let ponytail: THREE.Group | undefined;
    if (headwear === 'ponytail') {
      ponytail = part(new THREE.Group());
      ponytail.position.set(.3, -.02, -.36);
      head.add(ponytail);
      this.sphere(ponytail, .2, 0, 0, 0, hair, .9, 1.15, .8, 12).rotation.z = -.4;
      this.sphere(ponytail, .15, .1, -.24, -.08, hair, .9, 1.25, .8, 12);
      part(this.box(head, .06, .02, .02, -.2, .3, .33, PALETTE.yellow, .008)).rotation.z = -.4;
    }
    if (headwear === 'beanie') {
      // Beanie: a soft cap, folded band and pom, with the locks peeking out below.
      const beanie = part(this.mesh(new THREE.SphereGeometry(.47, 18, 12, 0, Math.PI * 2, 0, Math.PI * .5), this.material(PALETTE.sage), head, 0, .1, -.02));
      beanie.rotation.x = -.15;
      const band = part(this.mesh(new THREE.TorusGeometry(.44, .05, 8, 22), this.material(shadeHex(PALETTE.sage, .9)), head, 0, .12, -.02));
      band.rotation.x = Math.PI / 2 - .15;
      part(this.sphere(head, .08, 0, .58, -.06, shadeHex(PALETTE.sage, .9), 1, 1, 1, 10));
      const pencil = part(new THREE.Group());
      pencil.position.set(.44, .06, .05);
      pencil.rotation.z = -.5;
      head.add(pencil);
      this.cylinder(pencil, .022, .022, .34, 0, 0, 0, PALETTE.yellow, 8);
      this.cylinder(pencil, .024, .024, .05, 0, .19, 0, PALETTE.peach, 8);
    }
    if (outfit === 'boss-turtleneck') {
      // Minimal owner look: a thick ribbed turtleneck collar in the cuff shade, a lighter panel on the upper left so the
      // navy keeps its outline against the dark chair, and the side part. No tie, lapels or shirt strip.
      for (const [y, radius, tube] of [[1.5, .25, .065], [1.59, .215, .055]] as const) {
        const rib = part(this.mesh(new THREE.TorusGeometry(radius, tube, 8, 18), cuff, body, 0, y, .01));
        rib.rotation.x = Math.PI / 2;
        rib.scale.set(1, .85, 1);
        rib.castShadow = false;
      }
      part(this.sphere(body, .13, -.15, 1.4, .25, shadeHex(shirt, 1.1), .75, 1.1, .35, 12)).castShadow = false;
      const sidePart = part(this.mesh(new THREE.TorusGeometry(.3, .018, 4, 10, Math.PI * .5), this.material(shadeHex(hair, 1.1)), head, 0, .12, -.02));
      sidePart.rotation.set(Math.PI / 2 - .2, 0, .6);
      sidePart.castShadow = false;
    }
    if (outfit === 'round-collar-lanyard' || outfit === 'round-collar') {
      // Seat 1's collar is white; seat 2's is the shirt one shade darker, so the two never read as the same outfit.
      const collar = part(this.mesh(new THREE.TorusGeometry(.19, .025, 5, 14, Math.PI), this.material(PALETTE.white), body, 0, 1.62, .02));
      if (outfit === 'round-collar') collar.material = cuff;
      collar.rotation.x = Math.PI / 2;
      collar.castShadow = false;
    }
    if (outfit === 'round-collar-lanyard') {
      for (const side of [-1, 1]) {
        const cord = part(this.box(body, .012, .26, .012, side * .07, 1.44, .34, PALETTE.dark, 0));
        cord.rotation.z = side * .28;
        cord.castShadow = false;
      }
      part(this.box(body, .09, .12, .01, 0, 1.27, .36, PALETTE.white, .008)).castShadow = false;
    }
    if (outfit === 'hoodie') {
      layer(this.mesh(new THREE.TorusGeometry(.24, .05, 6, 16), this.material(shirt), body, 0, 1.63, -.02)).rotation.x = Math.PI / 2 + .15;
      for (const side of [-1, 1]) part(this.cylinder(body, .012, .012, .3, side * .06, 1.45, .36, PALETTE.white, 6)).castShadow = false;
    }
    if (outfit === 'vest-watch') {
      for (const side of [-1, 1]) layer(this.box(body, .3, .55, .05, side * .18, 1.3, .3, shirt, .02)).rotation.z = -side * .12;
    }
    if (outfit === 'check-shirt') {
      // Plaid shirt: a thin grid over the torso and two collar tips.
      for (let i = 0; i < 3; i++) layer(this.box(body, .62, .012, .05, 0, 1.12 + i * .14, .3, shirt, 0));
      for (const dx of [-.14, .14]) layer(this.box(body, .012, .5, .05, dx, 1.26, .3, shirt, 0));
      for (const side of [-1, 1]) {
        const tip = part(this.box(body, .12, .1, .02, side * .1, 1.6, .28, PALETTE.white, .008));
        tip.rotation.z = side * .5;
        tip.castShadow = false;
      }
    }
    if (look.glasses !== 'none') {
      // The owner wears thin navy rings with temples; employees wear thicker sage frames, square ones as four-segment
      // rings turned 45 degrees, so no employee's glasses read as the owner's.
      const square = look.glasses === 'square', thin = look.isBoss;
      const frameColor = thin ? OWNER_LOOK.frame : EMPLOYEE_LOOK.frame;
      for (const eyeX of [-.155, .155]) {
        const frame = part(this.mesh(new THREE.TorusGeometry(square ? .11 : .094, thin ? .008 : .014, 6, square ? 4 : 16), this.material(frameColor), head, eyeX, .01, .413));
        if (square) frame.rotation.z = Math.PI / 4;
        if (thin) frame.castShadow = false;
      }
      part(this.box(head, .14, thin ? .012 : .02, thin ? .012 : .02, 0, .018, .42, frameColor, thin ? 0 : .008)).castShadow = !thin;
      if (thin) for (const side of [-1, 1]) {
        const temple = part(this.box(head, .012, .012, .34, side * .345, .02, .255, frameColor, 0));
        temple.rotation.y = -side * .45;
        temple.castShadow = false;
      }
    }
    if (look.headphones) {
      part(this.mesh(new THREE.TorusGeometry(.465, .045, 8, 20, Math.PI), this.material('#566b61'), head, 0, .035, -.01));
      for (const dx of [-.43, .43]) part(this.sphere(head, .113, dx, .035, -.01, '#52685f', .5, 1.35, 1));
    }
    const smartWatch = outfit === 'vest-watch';
    const watchFace = smartWatch ? new THREE.MeshStandardMaterial({ color: PALETTE.mint, emissive: PALETTE.mint, emissiveIntensity: 0, roughness: .6 }) : undefined;
    if (variation === 0 || smartWatch) {
      // Wrist watch or smart watch: dark band with a small face.
      const strap = part(this.mesh(new THREE.TorusGeometry(.1, .014, 5, 12), this.material(PALETTE.dark), leftArm, -.035, -.27, .12));
      strap.rotation.x = Math.PI / 2;
      strap.castShadow = false;
      const face = part(this.box(leftArm, .05, .012, .04, -.13, -.27, .12, smartWatch ? PALETTE.mint : PALETTE.blue, .006));
      if (watchFace) face.material = watchFace;
      face.castShadow = false;
    }
    if (variation === 1 || variation === 2) {
      const bandRing = part(this.mesh(new THREE.TorusGeometry(.1, .016, 5, 12), cuff, leftArm, -.035, -.27, .12));
      bandRing.rotation.x = Math.PI / 2;
      bandRing.castShadow = false;
    }
    return { parts, ponytail, hasWatch: variation !== 3 && variation !== 5, watchFace };
  }

  /** A reused figure taking another identity keeps its body, label and animation state and changes only the look. */
  private dressFigure(figure: AgentFigure, agentId: string, released: { roots: THREE.Object3D[]; keep: Set<THREE.Material> }): void {
    const look = figure.look;
    if (!look || !figure.trim || !figure.cuff) return;
    look.agentId = agentId;
    const appearance = appearanceFor(agentId), key = appearanceKey(appearance);
    if (look.key === key) return;
    for (const root of look.parts) { root.removeFromParent(); released.roots.push(root); }
    released.keep.add(figure.trim); released.keep.add(figure.cuff);
    const skin = this.material(appearance.skin), hair = this.material(appearance.hair);
    const boss = appearance.isBoss;
    const shoe = this.material(boss ? OWNER_LOOK.sneaker : EMPLOYEE_LOOK.shoe);
    const pants = this.material(boss ? OWNER_LOOK.jeans : EMPLOYEE_LOOK.pants), sole = this.material(boss ? OWNER_LOOK.sole : EMPLOYEE_LOOK.sole);
    for (const mesh of look.skin) mesh.material = skin;
    for (const mesh of look.hair) mesh.material = hair;
    for (const mesh of look.shoes) mesh.material = shoe;
    for (const mesh of look.pants ?? []) mesh.material = pants;
    for (const mesh of look.soles ?? []) mesh.material = sole;
    for (const object of look.bossOnly ?? []) object.visible = boss;
    const dressed = this.buildLook(figure.detail ?? figure.group, figure.head, figure.leftArm, appearance, figure.trim, figure.cuff);
    look.key = key; look.parts = dressed.parts;
    figure.ponytail = dressed.ponytail; figure.hasWatch = dressed.hasWatch; figure.watchFace = dressed.watchFace;
  }

  private cup(x: number, y: number, z: number, color: string, parent: THREE.Object3D = this.world): void {
    this.cylinder(parent, .12, .105, .22, x, y + .11, z, color, 18);
    this.cylinder(parent, .097, .097, .007, x, y + .224, z, '#695746', 18);
    const handle = this.mesh(new THREE.TorusGeometry(.073, .027, 6, 12), this.material(color), parent, x + .12, y + .115, z);
    handle.rotation.y = Math.PI / 2;
  }

  private plant(x: number, z: number, scale: number, pot: string, base = 0, parent: THREE.Object3D = this.world, variant = 0): void {
    const group = new THREE.Group();
    group.position.set(x, base, z);
    group.scale.setScalar(scale);
    parent.add(group);
    this.cylinder(group, .28, .2, .45, 0, .225, 0, pot, 20);
    this.cylinder(group, .28, .28, .08, 0, .435, 0, pot, 20);
    this.cylinder(group, .24, .24, .015, 0, .48, 0, '#7f7058', 20);
    if (variant === 1) {
      // Cactus: a column with two arms and a bud.
      this.cylinder(group, .09, .1, .75, 0, .85, 0, '#809e71', 10);
      for (const side of [-1, 1]) {
        const limb = this.cylinder(group, .05, .05, .3, side * .16, .78, 0, '#92b27e', 8);
        limb.rotation.z = side * .35;
      }
      this.sphere(group, .09, 0, 1.25, 0, '#adc38d', 1, 1, 1, 10);
      return;
    }
    if (variant === 2) {
      // Round foliage: three flattened spheres stacked off-center.
      this.cylinder(group, .025, .034, .4, 0, .66, 0, '#819671', 8);
      this.sphere(group, .28, 0, .78, 0, '#809e71', 1, .7, 1, 12);
      this.sphere(group, .24, .1, .98, -.06, '#92b27e', 1, .7, 1, 12);
      this.sphere(group, .19, -.08, 1.14, .05, '#adc38d', 1, .7, 1, 12);
      return;
    }
    this.cylinder(group, .025, .034, .85, 0, .88, 0, '#819671', 8);
    for (let i = 0; i < 8; i++) {
      const angle = i * 2.4;
      const height = .67 + i * .086;
      const leaf = this.sphere(group, .22, Math.sin(angle) * .2, height, Math.cos(angle) * .2,
        i % 3 === 0 ? '#adc38d' : i % 2 ? '#809e71' : '#92b27e', .69, 1.45, .38);
      leaf.rotation.set(Math.cos(angle) * .55, -angle, Math.sin(angle) * .6);
    }
    this.sphere(group, .2, 0, 1.4, 0, '#a6bf86', .6, 1.35, .5);
  }

  private removePaperFlight(flight: PaperFlight): void {
    for (const mesh of [flight.plane, flight.arrival]) {
      mesh.traverse(child => {
        if (!(child instanceof THREE.Mesh || child instanceof THREE.Line)) return;
        child.geometry.dispose();
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
      });
      mesh.removeFromParent();
    }
    const index = this.paperFlights.indexOf(flight);
    if (index >= 0) this.paperFlights.splice(index, 1);
    if (flight.recipient) flight.recipient.lookYaw = null;
  }

  private updatePaperFlights(delta: number): void {
    for (const flight of this.paperFlights) if (flight.recipient) flight.recipient.lookYaw = null;
    for (const flight of [...this.paperFlights]) {
      flight.elapsed += delta;
      const progress = Math.min(1, flight.elapsed / flight.duration);
      const recipientHead = progress < 1 && flight.fromId !== flight.toId && flight.recipient.group?.visible
        ? flight.recipient.head?.getWorldPosition(new THREE.Vector3()) : undefined;
      if (recipientHead) {
        flight.recipient.lookYaw = Math.atan2(flight.plane.position.x - recipientHead.x, flight.plane.position.z - recipientHead.z);
        if (flight.duration - flight.elapsed < .5) flight.recipient.catchUntil = this.elapsed + .2;
      }
      if (progress < 1) {
        flight.plane.scale.setScalar(paperPlaneScale((this.camera.top - this.camera.bottom) / (Math.max(1, this.container.clientHeight) * this.camera.zoom)));
        flight.plane.position.copy(flight.curve.getPoint(progress));
        flight.plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), flight.curve.getTangent(progress));
        flight.plane.rotateZ(Math.sin(progress * Math.PI * 2) * .18);
        updatePaperPlaneTrail(flight.trail, flight.plane, flight.curve, progress);
      } else {
        flight.plane.position.copy(flight.curve.getPoint(1));
        flight.plane.visible = false;
        flight.arrival.visible = true;
        const receiptProgress = Math.min(1, (flight.elapsed - flight.duration) / .8);
        flight.arrival.scale.setScalar(this.reducedMotion ? 1 : 1 + receiptProgress * 1.5);
        (flight.arrival.material as THREE.MeshBasicMaterial).opacity = this.reducedMotion ? .65 : .75 * (1 - receiptProgress);
        if (receiptProgress >= 1) this.removePaperFlight(flight);
      }
    }
  }

  private nextActionCycle(figure: AgentFigure): number {
    figure.actionCycle = (figure.actionCycle ?? 0) + 1;
    return figure.actionCycle;
  }

  /** New status or a new person: every small action waits its own staggered delay again. */
  private resetActionTimers(figure: AgentFigure, id: string): void {
    const cycle = this.nextActionCycle(figure);
    figure.blinkStartedAt = null; figure.nextBlinkAt = this.elapsed + actionDelay(id, 'blink', cycle, 3, 3);
    figure.reachStartedAt = null; figure.nextReachAt = this.elapsed + actionDelay(id, 'reach', cycle, 12, 8);
    figure.flipStartedAt = null; figure.nextFlipAt = this.elapsed + actionDelay(id, 'flip', cycle, 8, 6);
    figure.tapStartedAt = null; figure.nextTapAt = this.elapsed + actionDelay(id, 'tap', cycle, 10, 8);
    figure.sipStartedAt = null; figure.nextSipAt = this.elapsed + actionDelay(id, 'sip', cycle, 40, 30);
    figure.glanceStartedAt = null; figure.nextGlanceAt = this.elapsed + actionDelay(id, 'glance', cycle, 6, 3);
    figure.lookYaw = null; figure.catchUntil = 0; figure.pushUntil = 0; figure.bowUntil = 0;
    if (figure.handMug) figure.handMug.visible = false;
  }

  private stopTransientActions(figure: AgentFigure): void {
    figure.blinkStartedAt = null; figure.reachStartedAt = null; figure.flipStartedAt = null;
    figure.tapStartedAt = null; figure.sipStartedAt = null; figure.glanceStartedAt = null;
    figure.lookYaw = null; figure.catchUntil = 0; figure.pushUntil = 0; figure.bowUntil = 0; figure.nodUntil = 0;
    if (figure.handMug) figure.handMug.visible = false;
    if (figure.handSheet) figure.handSheet.visible = false;
    if (figure.surveyStartedAt != null) figure.surveyStartedAt = null;
    if (figure.attention) figure.attention = 0;
    if (figure.callBlend) this.hangUp(figure);
  }

  /** Rounded-rectangle slab centered on the origin, cached with the other geometry and released when nobody uses it. */
  private phonePlate(width: number, height: number, depth: number, radius: number, bevel = 0): THREE.BufferGeometry {
    const key = `phone-plate/${width}/${height}/${depth}/${radius}/${bevel}`;
    const cached = this.geometryCache.get(key);
    if (cached) return cached;
    const w = width / 2 - bevel, h = height / 2 - bevel, r = Math.min(radius, w, h);
    const shape = new THREE.Shape();
    shape.moveTo(-w + r, -h);
    shape.lineTo(w - r, -h); shape.quadraticCurveTo(w, -h, w, -h + r);
    shape.lineTo(w, h - r); shape.quadraticCurveTo(w, h, w - r, h);
    shape.lineTo(-w + r, h); shape.quadraticCurveTo(-w, h, -w, h - r);
    shape.lineTo(-w, -h + r); shape.quadraticCurveTo(-w, -h, -w + r, -h);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(.0005, depth - bevel * 2), bevelEnabled: bevel > 0,
      bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, steps: 1, curveSegments: 5 });
    geometry.translate(0, 0, -depth / 2 + bevel);
    this.geometryCache.set(key, geometry);
    return geometry;
  }

  /** A logo-free rounded smartphone with its screen on local +Z: dark glass while idle and a rear module with three lenses. */
  private buildPhone(parent: THREE.Object3D): THREE.Group {
    const phone = new THREE.Group();
    phone.name = 'employee-phone';
    phone.rotation.order = 'YXZ';
    phone.position.set(PHONE_DESK.x, PHONE_DESK.y, PHONE_DESK.z);
    phone.rotation.set(-Math.PI / 2, PHONE_DESK.yaw, 0);
    parent.add(phone);
    const { width, height, depth, corner } = PHONE;
    const body = this.mesh(this.phonePlate(width, height, depth, corner, .006), this.material(PHONE.body, .5), phone);
    body.material = [this.material(PHONE.body, .5), this.material(PHONE.side, .5)];
    body.name = 'phone-body';
    this.mesh(this.phonePlate(width - .016, height - .016, .002, corner - .008), this.material(PHONE.glass, .35), phone, 0, 0, depth / 2 + .001)
      .name = 'phone-screen-off';
    // Seen from the back, the camera module sits top-left (local +X).
    const moduleX = width / 2 - .05, moduleY = height / 2 - .05, back = -depth / 2;
    this.mesh(this.phonePlate(.075, .075, .008, .02), this.material(PHONE.module, .5), phone, moduleX, moduleY, back - .004).name = 'phone-camera-module';
    for (const [dx, dy] of [[.018, .018], [.018, -.018], [-.018, 0]] as const) {
      this.cylinder(phone, .013, .013, .006, moduleX + dx, moduleY + dy, back - .011, PHONE.side, 12).rotation.x = Math.PI / 2;
    }
    this.cylinder(phone, .006, .006, .004, moduleX - .018, moduleY + .024, back - .01, PHONE.flash, 8).rotation.x = Math.PI / 2;
    for (const child of phone.children) child.castShadow = false;
    return phone;
  }

  /** The lit call screen: cream glass, a camera pill, a green call icon and nine waveform bars. Built once, on a figure's first call. */
  private buildPhoneScreen(figure: AgentFigure): void {
    const phone = figure.phone;
    if (!phone || figure.phoneScreen) return;
    const { width, height, depth, corner } = PHONE;
    const screen = new THREE.Group();
    screen.name = 'phone-call-screen';
    screen.position.z = depth / 2 + .003;
    phone.add(screen);
    this.mesh(this.phonePlate(width - .016, height - .016, .002, corner - .008), this.material(PHONE.screen, .55), screen).name = 'phone-screen-on';
    this.mesh(this.phonePlate(.044, .012, .002, .006), this.material(PHONE.body, .5), screen, 0, height / 2 - .03, .002);
    const icon = this.cylinder(screen, .03, .03, .002, 0, .055, .002, PHONE.call, 18);
    icon.name = 'phone-call-icon';
    icon.rotation.x = Math.PI / 2;
    this.box(screen, .032, .009, .002, 0, .055, .004, PALETTE.white, 0).rotation.z = Math.PI / 4;
    const bars = CALL_WAVE_BARS.map((level, index) => {
      const bar = this.box(screen, .009, .08, .002, (index - 4) * .014, -.06, .002, PHONE.wave, 0);
      bar.name = 'phone-wave-bar';
      bar.scale.y = level;
      return bar;
    });
    for (const child of screen.children) child.castShadow = false;
    screen.visible = false;
    figure.phoneScreen = screen; figure.phoneBars = bars; figure.callWaveStep = -1;
  }

  /** Puts the phone down at once: the mouse arm returns to its seated pivot and the phone to the desk. */
  private hangUp(figure: AgentFigure): void {
    figure.callBlend = 0;
    figure.leftArm.position.set(-.34, 1.4, .01);
    figure.leftArm.rotation.y = 0; figure.leftArm.rotation.z = 0;
    // The call's body turn ends too; seated frames recompute any swivel, and standing poses expect a square body.
    if (figure.detail) figure.detail.rotation.y = 0;
    this.placePhone(figure);
  }

  /** An employee on an external call turns the seated body about 20° and holds the phone to the ear; returns the eased weight. */
  private applyCallPose(figure: AgentFigure, delta: number, motion: number): number {
    const target = figure.onCall === true && motion > 0;
    const blend = figure.callBlend = motion
      ? THREE.MathUtils.clamp((figure.callBlend ?? 0) + (target ? delta : -delta) / CALL_ENTER_SECONDS, 0, 1) : 0;
    const e = smoothstep01(blend);
    const lerp = THREE.MathUtils.lerp;
    const left = figure.leftArm, right = figure.rightArm;
    // Exact at zero, so the seated pivot comes back once the phone is down.
    left.position.set(lerp(-.34, CALL_ARM.x, e), lerp(1.4, CALL_ARM.y, e), lerp(left.position.z, CALL_ARM.z, e));
    left.rotation.set(lerp(left.rotation.x, CALL_ARM.rx, e), 0, lerp(left.rotation.z, CALL_ARM.rz, e));
    if (e === 0) return 0;
    right.position.x = lerp(right.position.x, .34, e); right.position.z = lerp(right.position.z, .01, e);
    right.rotation.x = lerp(right.rotation.x, -.25, e); right.rotation.z = lerp(right.rotation.z, 0, e);
    figure.head.rotation.x = lerp(figure.head.rotation.x, .04, e);
    figure.head.rotation.z = lerp(figure.head.rotation.z, .08, e);
    if (figure.detail) figure.detail.rotation.y += CALL_TURN_RADIANS * e;
    return e;
  }

  /** The phone rests at a fixed desk spot whatever the body does (swivel, walk) and blends to the ear with the call. */
  private placePhone(figure: AgentFigure): void {
    const phone = figure.phone;
    if (!phone) return;
    const group = figure.group, seatYaw = figure.homeYaw;
    const seatCos = Math.cos(seatYaw), seatSin = Math.sin(seatYaw);
    const dx = figure.origin.x + PHONE_DESK.x * seatCos + PHONE_DESK.z * seatSin - group.position.x;
    const dz = figure.origin.z - PHONE_DESK.x * seatSin + PHONE_DESK.z * seatCos - group.position.z;
    const yaw = group.rotation.y + (figure.detail?.rotation.y ?? 0);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    phoneDeskPosition.set(dx * cos - dz * sin, PHONE_DESK.y - group.position.y, dx * sin + dz * cos);
    phoneDeskEuler.set(-Math.PI / 2, seatYaw + PHONE_DESK.yaw - yaw, 0);
    phoneDeskQuaternion.setFromEuler(phoneDeskEuler);
    const e = smoothstep01(figure.callBlend ?? 0);
    phone.position.lerpVectors(phoneDeskPosition, PHONE_EAR_POSITION, e);
    phone.quaternion.slerpQuaternions(phoneDeskQuaternion, PHONE_EAR_QUATERNION, e);
  }

  /** Waveform bars step every .4s only for animated close-up desks; elsewhere they keep the still design heights. */
  private updatePhoneScreen(figure: AgentFigure, motion: number): void {
    const bars = figure.phoneBars;
    if (!bars || !figure.phoneScreen?.visible) return;
    const animated = motion > 0 && !!this.detailedWorkIds?.has(figure.id);
    const step = animated ? Math.floor((this.elapsed + figure.phase) / CALL_WAVE_STEP_SECONDS) : -1;
    if (step === figure.callWaveStep) return;
    figure.callWaveStep = step;
    for (let index = 0; index < bars.length; index++) bars[index]!.scale.y = callWaveLevel(index, step);
  }

  /** Brows, eye height and one visible mouth express the status; a short blend keeps changes soft. */
  private applyExpression(figure: AgentFigure, expression: string, motion: number): void {
    if (!figure.brows || !figure.eyes) return;
    const mouthFor = (kind: string): string => kind === 'working' ? 'line' : kind === 'thinking' || kind === 'approval' || kind === 'call' ? 'open' : kind === 'error' ? 'wave' : 'smile';
    if (figure.expression !== expression) {
      figure.previousMouth = mouthFor(figure.expression ?? 'idle');
      figure.expression = expression;
      figure.expressionSince = this.elapsed;
    }
    const age = this.elapsed - (figure.expressionSince ?? this.elapsed);
    const k = motion && !this.paused ? Math.min(1, age / .25) : 1;
    const blend = k * k * (3 - 2 * k);
    const [browLeft, browRight, lift, open, mouthScale, eyeLift] =
      expression === 'working' ? [-.08, .08, 0, .7, 1, 0]
        : expression === 'thinking' ? [-.15, .06, .02, 1, .7, .012]
          : expression === 'approval' ? [0, 0, .03, 1.1, 1, 0]
            : expression === 'error' ? [.35, -.35, -.01, 1, 1, 0]
              : expression === 'done' ? [0, 0, .01, .25, 1.3, 0]
                : expression === 'call' ? [0, 0, .01, 1, .62, 0]
                  : [0, 0, 0, 1, 1, 0];
    const mouth = mouthFor(expression);
    const [left, right] = figure.brows;
    if (left) { left.rotation.z = browLeft * blend; left.position.y = .11 + lift * blend; }
    if (right) { right.rotation.z = browRight * blend; right.position.y = .11 + lift * blend; }
    let eyeOpen = 1 - (1 - open) * blend;
    if (figure.blinkStartedAt == null && motion && figure.nextBlinkAt !== undefined && this.elapsed >= figure.nextBlinkAt && !this.paused && expression !== 'done') figure.blinkStartedAt = this.elapsed;
    if (figure.blinkStartedAt != null) {
      const blink = Math.min(1, (this.elapsed - figure.blinkStartedAt) / .12);
      eyeOpen *= 1 - .9 * Math.sin(blink * Math.PI);
      if (blink >= 1) { figure.blinkStartedAt = null; figure.nextBlinkAt = this.elapsed + actionDelay(figure.id, 'blink', this.nextActionCycle(figure), 3, 3); }
    }
    for (const eye of figure.eyes) { eye.scale.y = 1.13 * eyeOpen; eye.position.y = .012 + eyeLift * blend; }
    const shown = blend > .5 ? mouth : figure.previousMouth ?? 'smile';
    if (figure.smile) { figure.smile.visible = shown === 'smile'; figure.smile.scale.setScalar(shown === 'smile' ? mouthScale : 1); }
    if (figure.mouthLine) figure.mouthLine.visible = shown === 'line';
    if (figure.mouthOpen) {
      figure.mouthOpen.visible = shown === 'open'; figure.mouthOpen.scale.set(.8 * mouthScale, 1.1 * mouthScale, .3);
      // Talking on the phone: the mouth only opens and closes a little.
      if (expression === 'call' && motion) figure.mouthOpen.scale.y *= .5 + .5 * Math.abs(Math.sin(this.elapsed * 9 + figure.phase));
    }
    if (figure.mouthWave) figure.mouthWave.visible = shown === 'wave';
    if (figure.sweat) figure.sweat.visible = expression === 'error' && blend > .5;
  }

  private cancelYawn(figure: AgentFigure): void {
    if (figure.yawnStartedAt === null) return;
    figure.yawnStartedAt = null;
    figure.nextYawnAt = this.elapsed + idleYawnDelay(figure.id, ++figure.yawnCycle);
    figure.head.rotation.set(0, 0, 0);
    figure.head.position.y = 1.96;
    figure.rightArm.position.set(.34, 1.4, .01);
    figure.rightArm.rotation.set(-.25, 0, 0);
    if (figure.yawnMouth) figure.yawnMouth.visible = false;
    if (figure.smile) figure.smile.visible = true;
    for (const eye of figure.eyes ?? []) eye.scale.y = 1.13;
  }

  private ownerFigure(): AgentFigure | undefined {
    const seat = this.agentSeats?.get('boss');
    const figure = seat === undefined ? undefined : this.figures[seat];
    return figure?.id === 'boss' && figure.group.visible ? figure : undefined;
  }

  /** The waiting approval visitor nearest the owner, if any. */
  private waitingVisitor(owner: AgentFigure): AgentFigure | undefined {
    let nearest: AgentFigure | undefined, best = Infinity;
    for (const visit of this.approvalVisits?.values() ?? []) {
      if (visit.stage !== 'waiting' || !visit.figure.group.visible) continue;
      const distance = visit.figure.group.position.distanceToSquared(owner.group.position);
      if (distance < best) { best = distance; nearest = visit.figure; }
    }
    return nearest;
  }

  /** approval.resolved's stamp and its closing nod. */
  private ownerStamping(owner: AgentFigure): boolean {
    return !!this.stampPending || this.elapsed < (this.stampUntil ?? 0) || owner.nodUntil !== undefined && this.elapsed < owner.nodUntil;
  }

  private activeOwnerAction(): { kind: OwnerActionKind; startedAt: number; duration: number } | null {
    const action = this.ownerAction ?? null;
    return action && this.elapsed - action.startedAt < action.duration ? action : null;
  }

  private ownerBusy(owner: AgentFigure): boolean {
    return !!this.activeOwnerAction() || owner.surveyStartedAt != null || (owner.attention ?? 0) > 0;
  }

  /**
   * Starts one of the owner's moments unless motion is off, the owner is stamping, attending a visitor or delivering,
   * or a higher moment is running. A running click reaction or spin is never restarted by another click.
   */
  private requestOwnerAction(kind: OwnerActionKind): boolean {
    const owner = this.ownerFigure();
    if (!owner || this.disposed || this.reducedMotion || this.paused || this.buildingView) return false;
    if (this.ownerStamping(owner) || this.waitingVisitor(owner)
      || this.deliveries?.some(delivery => delivery.courier === owner || delivery.recipient === owner)) return false;
    const current = this.activeOwnerAction();
    if (current && (OWNER_ACTION_RANK[current.kind] > OWNER_ACTION_RANK[kind] || current.kind === kind && kind !== 'instruct' || current.kind === 'spin')) return false;
    this.ownerAction = { kind, startedAt: this.elapsed, duration: OWNER_ACTION_SECONDS[kind] };
    return true;
  }

  /** A click on the owner: look up, straighten the glasses and nod; the fifth click within three seconds spins the chair once. */
  private reactToOwnerClick(): boolean {
    const owner = this.ownerFigure();
    if (!owner || this.reducedMotion || this.paused || this.ownerStamping(owner) || this.waitingVisitor(owner)) {
      this.ownerClicks = [];
      return false;
    }
    const { times, spin } = registerOwnerClick(this.ownerClicks ?? [], this.clockSeconds());
    this.ownerClicks = times;
    return this.requestOwnerAction(spin ? 'spin' : 'click');
  }

  /**
   * The owner's pose after the status pose. Priority: attending a waiting visitor > filing a finished visit > reaching out
   * with an instruction > a click reaction or chair spin > watching the monitor with an occasional look over the office.
   * Idle moments turn only the head, so idle arm angles stay identical from frame to frame.
   */
  private updateOwnerPose(owner: AgentFigure, delta: number, motion: number, idleLike: boolean, involvedInDelivery: boolean): void {
    if (owner.handSheet) owner.handSheet.visible = false;
    const stamping = this.ownerStamping(owner);
    const visitor = motion && !involvedInDelivery && !stamping ? this.waitingVisitor(owner) : undefined;
    if (visitor) {
      const yaw = Math.atan2(visitor.group.position.x - owner.group.position.x, visitor.group.position.z - owner.group.position.z)
        - owner.group.rotation.y - (owner.detail?.rotation.y ?? 0);
      owner.attentionYaw = THREE.MathUtils.clamp(Math.atan2(Math.sin(yaw), Math.cos(yaw)), -.75, .75);
    }
    // Attention eases in and out over .4s of animation time, so a pause freezes it.
    owner.attention = motion ? THREE.MathUtils.clamp((owner.attention ?? 0) + (visitor ? delta : -delta) / .4, 0, 1) : 0;
    if (!motion || involvedInDelivery || stamping || visitor) {
      this.ownerAction = null; this.ownerFinishRequestedAt = null; owner.surveyStartedAt = null;
    }
    if (this.ownerFinishRequestedAt != null && this.elapsed - this.ownerFinishRequestedAt > OWNER_FINISH_WAIT_SECONDS) this.ownerFinishRequestedAt = null;
    let action = this.activeOwnerAction();
    if (!action) this.ownerAction = null;
    if (this.ownerFinishRequestedAt != null && !this.paused && (!action || OWNER_ACTION_RANK[action.kind] < OWNER_ACTION_RANK.finish)) {
      action = this.ownerAction = { kind: 'finish', startedAt: this.elapsed, duration: OWNER_ACTION_SECONDS.finish };
      this.ownerFinishRequestedAt = null; owner.surveyStartedAt = null;
    }
    const blend = smoothstep01(owner.attention);
    if (blend > 0) {
      // Turn from the monitor toward the visitor and hold a level gaze for the whole visit.
      owner.head.rotation.y += ((owner.attentionYaw ?? 0) - owner.head.rotation.y) * blend;
      owner.head.rotation.x *= 1 - blend;
    }
    if (stamping || visitor) return;
    if (action) {
      const k = THREE.MathUtils.clamp((this.elapsed - action.startedAt) / action.duration, 0, 1);
      if (action.kind === 'finish') {
        // Take the visitor's sheet, lay it on the tray at the left and nod once. No stamp: the outcome stays unsaid.
        const reach = smoothstep01(k / .3), file = smoothstep01((k - .3) / .35), back = smoothstep01((k - .7) / .3);
        owner.leftArm.rotation.x = THREE.MathUtils.lerp(THREE.MathUtils.lerp(-.28, -1.45, reach), -.28, back);
        owner.leftArm.rotation.z = -.95 * file * (1 - back);
        owner.head.rotation.y = -.45 * file * (1 - back);
        owner.head.rotation.x = k < .7 ? .12 * reach : .22 * Math.sin((k - .7) / .3 * Math.PI);
        // The tray already shows the reported request count (syncApprovalPile runs when the visit ends); the sheet in
        // hand is only the gesture, so it vanishes at .62 without adding or removing a pile sheet.
        if (owner.handSheet) owner.handSheet.visible = k > .08 && k < .62;
      } else if (action.kind === 'instruct') {
        // Reach out toward the monitor as the plane leaves it.
        const bell = Math.sin(k * Math.PI);
        owner.rightArm.rotation.x = -.25 - 1.3 * bell;
        owner.rightArm.rotation.z = -.12 * bell;
        owner.rightArm.position.z = .01 + .12 * bell;
      } else if (action.kind === 'click') {
        // Look up, straighten the glasses with the right hand, then nod twice.
        const hand = Math.sin(THREE.MathUtils.clamp((k - .15) / .47, 0, 1) * Math.PI);
        owner.head.rotation.x = k < .62 ? -.2 * Math.sin(k / .62 * Math.PI) : .18 * Math.abs(Math.sin((k - .62) / .38 * Math.PI * 2));
        owner.head.rotation.y *= 1 - hand;
        owner.rightArm.position.set(.34 - .21 * hand, 1.4 + .36 * hand, .01 + .2 * hand);
        owner.rightArm.rotation.set(-.25 - 2.05 * hand, 0, -.42 * hand);
      } else if (owner.detail) {
        // Chair spin: the seated body turns once in place; the chair furniture stays merged with the room.
        owner.detail.rotation.y += Math.PI * 2 * smoothstep01(k);
      }
      return;
    }
    if (!idleLike) { owner.surveyStartedAt = null; return; }
    // Watching the monitor: a slight downward gaze that eases out while a visitor's attention fades.
    owner.head.rotation.x = .1 * (1 - blend);
    if (!motion) return;
    owner.nextSurveyAt ??= this.elapsed + actionDelay('boss', 'survey', 0, 9, 7);
    if (owner.surveyStartedAt == null && this.elapsed >= owner.nextSurveyAt && !this.paused && blend === 0 && owner.sipStartedAt == null) owner.surveyStartedAt = this.elapsed;
    if (owner.surveyStartedAt != null) {
      const k = Math.min(1, (this.elapsed - owner.surveyStartedAt) / OWNER_SURVEY_SECONDS);
      const sweep = (1 - Math.cos(k * Math.PI * 2)) / 2;
      // Look toward the middle of the office floor and back to the monitor.
      const bounds = this.bounds ?? officeBounds(1);
      const yaw = Math.atan2(bounds.centerX - owner.group.position.x, bounds.centerZ - owner.group.position.z) - owner.group.rotation.y;
      const toward = THREE.MathUtils.clamp(Math.atan2(Math.sin(yaw), Math.cos(yaw)), -.7, .7);
      owner.head.rotation.y += (toward - owner.head.rotation.y) * sweep;
      owner.head.rotation.x = .1 * (1 - sweep);
      if (k >= 1) { owner.surveyStartedAt = null; owner.nextSurveyAt = this.elapsed + actionDelay('boss', 'survey', this.nextActionCycle(owner), 14, 10); }
    }
  }

  private startApprovalVisits(): void {
    if (!this.agentSeats.has('boss')) return;
    for (const id of this.approvalRequests) {
      if (this.approvalVisits.size >= 9) break;
      if (this.approvalVisits.has(id) || this.deliveries.some(delivery => delivery.courier.id === id || delivery.recipient.id === id)) continue;
      const index = this.agentSeats.get(id);
      const figure = index === undefined ? undefined : this.figures[index];
      if (!figure) continue;
      this.cancelYawn(figure);
      const used = new Set([...this.approvalVisits.values()].map(visit => visit.slot));
      let slot = 0; while (used.has(slot)) slot++;
      const route = routeToApproval(figure.seat, slot).map(point => new THREE.Vector3(point.x, 0, point.z));
      this.setStandingLegs(figure);
      figure.paper.visible = true;
      this.approvalVisits.set(id, { figure, route, leg: 0, progress: 0, stage: 'out', slot });
    }
  }

  private returnFromApproval(visit: ApprovalVisit): void {
    if (visit.stage === 'return') return;
    this.approvalRequests.delete(visit.figure.id);
    this.syncApprovalPile();
    // Reverse only the path already walked; resolving in transit must not teleport the employee.
    const traveled = visit.stage === 'waiting' ? visit.route : visit.route.slice(0, visit.leg + 1);
    visit.route = [visit.figure.group.position.clone().setY(0), ...traveled.map(point => point.clone()).reverse()];
    visit.stage = 'return'; visit.leg = 0; visit.progress = 0;
    visit.figure.paper.visible = false;
    delete visit.figure.label.dataset.approvalVisit;
  }

  private updateApprovalVisits(delta: number): void {
    const bossSeat = this.agentSeats.get('boss');
    const boss = bossSeat === undefined ? undefined : this.figures[bossSeat];
    for (const [id, visit] of this.approvalVisits) {
      const figure = visit.figure;
      if (visit.stage === 'waiting') {
        this.setStandingLegs(figure);
        figure.group.position.y = 0;
        if (boss) figure.group.rotation.y = Math.atan2(boss.origin.x - figure.group.position.x, boss.origin.z - figure.group.position.z);
        figure.rightArm.rotation.x = -.5;
        figure.rightArm.rotation.z = -1.4 + (this.reducedMotion ? 0 : Math.sin(this.elapsed * 3) * .1);
        figure.leftArm.rotation.x = -.8;
        figure.leftArm.rotation.z = 0;
        figure.paper.visible = true;
        figure.label.dataset.approvalVisit = 'waiting';
        if (!this.reducedMotion) {
          // Waiting at the door: a tapping foot, a glance at the watch, and a bow when the stamp lands.
          figure.rightKnee.rotation.x = Math.abs(Math.sin(this.elapsed * 6.9)) * .12;
          if (figure.hasWatch) {
            if (figure.glanceStartedAt === null && figure.nextGlanceAt !== undefined && this.elapsed >= figure.nextGlanceAt) figure.glanceStartedAt = this.elapsed;
            if (figure.glanceStartedAt != null) {
              const k = Math.min(1, (this.elapsed - figure.glanceStartedAt) / .9);
              const bell = Math.sin(k * Math.PI);
              figure.leftArm.rotation.x = -.8 - .55 * bell;
              figure.leftArm.rotation.z = .45 * bell;
              figure.head.rotation.x = .3 * bell;
              if (k >= 1) { figure.glanceStartedAt = null; figure.nextGlanceAt = this.elapsed + actionDelay(figure.id, 'glance', this.nextActionCycle(figure), 6, 3); }
            }
          }
          if (figure.bowUntil !== undefined && this.elapsed < figure.bowUntil) {
            const k = Math.min(1, (figure.bowUntil - this.elapsed) / 1.85);
            figure.head.rotation.x = .35 * Math.sin(k * Math.PI);
          } else if (figure.glanceStartedAt == null) figure.head.rotation.x = 0;
        } else figure.head.rotation.x = 0;
        continue;
      }
      const start = visit.route[visit.leg], end = visit.route[visit.leg + 1];
      if (!start || !end) {
        if (visit.stage === 'out') { visit.stage = 'waiting'; figure.group.position.y = 0; figure.label.dataset.approvalVisit = 'waiting'; }
        else { this.restoreSeatedFigure(figure); figure.paper.visible = false; this.approvalVisits.delete(id); }
        continue;
      }
      visit.progress = this.reducedMotion ? 1 : Math.min(1, visit.progress + delta * 4.5 / Math.max(.01, start.distanceTo(end)));
      figure.group.position.lerpVectors(start, end, visit.progress);
      const step = this.elapsed * 11;
      figure.group.position.y = this.reducedMotion ? 0 : Math.abs(Math.sin(step)) * .055;
      figure.group.rotation.y = Math.atan2(end.x - start.x, end.z - start.z);
      this.setStandingLegs(figure);
      figure.leftLeg.rotation.x = this.reducedMotion ? 0 : Math.sin(step) * .38;
      figure.rightLeg.rotation.x = -figure.leftLeg.rotation.x;
      figure.leftArm.rotation.x = -figure.leftLeg.rotation.x;
      figure.rightArm.rotation.x = -.6;
      if (visit.progress >= 1) { visit.leg++; visit.progress = 0; }
    }
    this.startApprovalVisits();
  }

  private startNextDelivery(): void {
    if (!this.queued.length || this.deliveries.length >= 4) return;
    const index = this.queued.findIndex(item => !this.approvalVisits.has(item.from) && !this.approvalVisits.has(item.to) && !this.approvalRequests.has(item.from) && !this.deliveries.some(delivery =>
      delivery.courier.id === item.from || delivery.recipient.id === item.from
      || delivery.courier.id === item.to || delivery.recipient.id === item.to));
    if (index < 0) return;
    const item = this.queued.splice(index, 1)[0];
    if (!item) return;
    const fromIndex = this.agentSeats.get(item.from);
    const toIndex = this.agentSeats.get(item.to);
    if (fromIndex === undefined || toIndex === undefined) return;
    const courier = this.figures[fromIndex];
    const recipient = this.figures[toIndex];
    if (!courier || !recipient) return;
    this.cancelYawn(courier);
    this.cancelYawn(recipient);
    const route = routeBetweenSeats(fromIndex, toIndex).map(point => new THREE.Vector3(point.x, 0, point.z));
    this.setStandingLegs(courier);
    courier.paper.position.set(.49, 1.42, .2);
    courier.paper.rotation.set(-.14, .06, -.18);
    courier.paper.visible = true;
    this.deliveries.push({ courier, recipient, route, leg: 0, progress: 0, stage: 'out', timer: 0 });
  }

  private setStandingLegs(figure: AgentFigure): void {
    if (figure.detail) figure.detail.rotation.y = 0;
    figure.leftLeg.rotation.set(0, 0, 0);
    figure.rightLeg.rotation.set(0, 0, 0);
    figure.leftKnee.rotation.set(0, 0, 0);
    figure.rightKnee.rotation.set(0, 0, 0);
  }

  private restoreSeatedFigure(figure: AgentFigure): void {
    figure.group.position.copy(figure.origin);
    figure.group.rotation.set(0, figure.homeYaw, 0);
    figure.leftLeg.rotation.set(-Math.PI / 2, 0, 0);
    figure.rightLeg.rotation.set(-Math.PI / 2, 0, 0);
    figure.leftKnee.rotation.set(Math.PI / 2, 0, 0);
    figure.rightKnee.rotation.set(Math.PI / 2, 0, 0);
  }

  private updateDeliveries(delta: number): void {
    for (let i = this.deliveries.length - 1; i >= 0; i--) {
      const delivery = this.deliveries[i];
      if (!delivery) continue;
      if (delivery.stage === 'handoff') {
        this.setStandingLegs(delivery.courier);
        delivery.timer += delta;
        delivery.courier.group.rotation.y = Math.atan2(
          delivery.recipient.group.position.x - delivery.courier.group.position.x,
          delivery.recipient.group.position.z - delivery.courier.group.position.z);
        delivery.courier.rightArm.rotation.z = -.9;
        delivery.recipient.rightArm.rotation.z = -.7;
        delivery.recipient.paper.visible = delivery.timer > .65;
        delivery.courier.paper.visible = delivery.timer <= .65;
        if (delivery.timer > 1.5) {
          delivery.recipient.paper.visible = false;
          delivery.route.reverse();
          delivery.stage = 'return';
          delivery.leg = 0;
          delivery.progress = 0;
        }
        continue;
      }
      const start = delivery.route[delivery.leg];
      const end = delivery.route[delivery.leg + 1];
      if (!start || !end) {
        if (delivery.stage === 'out') {
          delivery.stage = 'handoff';
          delivery.timer = 0;
        } else {
          this.restoreSeatedFigure(delivery.courier);
          delivery.courier.paper.visible = false;
          this.deliveries.splice(i, 1);
        }
        continue;
      }
      const distance = start.distanceTo(end);
      delivery.progress = this.reducedMotion ? 1 : Math.min(1, delivery.progress + delta * 3.8 / Math.max(.01, distance));
      delivery.courier.group.position.lerpVectors(start, end, delivery.progress);
      const walkTime = this.elapsed * 11;
      if (!this.reducedMotion) delivery.courier.group.position.y = Math.abs(Math.sin(walkTime)) * .07;
      const facing = Math.atan2(end.x - start.x, end.z - start.z);
      delivery.courier.group.rotation.y = facing;
      delivery.courier.leftKnee.rotation.x = 0;
      delivery.courier.rightKnee.rotation.x = 0;
      delivery.courier.leftLeg.rotation.x = this.reducedMotion ? 0 : Math.sin(walkTime) * .38;
      delivery.courier.rightLeg.rotation.x = this.reducedMotion ? 0 : -Math.sin(walkTime) * .38;
      delivery.courier.leftArm.rotation.x = this.reducedMotion ? 0 : -Math.sin(walkTime) * .36;
      delivery.courier.rightArm.rotation.x = -.32;
      if (delivery.progress >= 1) {
        delivery.leg++;
        delivery.progress = 0;
      }
    }
    this.startNextDelivery();
  }

  private updateFigures(delta = 0): void {
    for (const figure of this.figures) {
      if (!figure.group.visible) continue;
      if (this.reducedMotion) this.stopTransientActions(figure);
      this.syncSignal(figure);
      const moving = this.approvalVisits.has(figure.id) || this.deliveries.some(delivery => delivery.courier === figure);
      const receiving = this.deliveries.some(delivery => delivery.recipient === figure && delivery.stage === 'handoff');
      const involvedInDelivery = this.deliveries.some(delivery => delivery.courier === figure || delivery.recipient === figure);
      // Walking away (a handoff or a visit) never carries the phone at the ear.
      if (moving && figure.callBlend) this.hangUp(figure);
      const t = this.elapsed + figure.phase;
      const selected = this.focusId === figure.id;
      const typing = figure.status === 'working';
      const reading = figure.status === 'thinking' || figure.status === 'reviewing'
        || typing && ['documents', 'reviewing', 'planning'].includes(figure.activityKind ?? '');
      const motion = this.reducedMotion ? 0 : 1;
      if (figure.id === 'boss' && !moving && this.stampPending) {
        this.stampPending = false;
        this.stampUntil = this.elapsed + 1.25;
        figure.nodUntil = this.stampUntil + .8;
        for (const visit of this.approvalVisits.values()) if (visit.stage === 'waiting') visit.figure.bowUntil = this.stampUntil + .6;
        // The reported resolution's stamp is the owner's one moment now.
        this.ownerAction = null; this.ownerFinishRequestedAt = null;
      }
      // The owner never yawns: an idle owner watches the monitor and now and then looks over the office instead.
      const canYawn = figure.id !== 'boss' && ['idle', 'waiting'].includes(figure.status) && !moving && !involvedInDelivery
        && !this.approvalRequests.has(figure.id) && !(figure.id === 'boss' && this.elapsed < this.stampUntil) && !this.reducedMotion;
      if (!canYawn || figure.yawnStartedAt !== null && this.elapsed - figure.yawnStartedAt >= YAWN_DURATION) this.cancelYawn(figure);
      if (canYawn && !this.paused && figure.yawnStartedAt === null && this.elapsed >= figure.nextYawnAt) figure.yawnStartedAt = this.elapsed;
      if (figure.approvalStamp) figure.approvalStamp.visible = !moving && this.elapsed < this.stampUntil;
      if (figure.handSheet && moving) figure.handSheet.visible = false;
      (figure.halo.material as THREE.MeshStandardMaterial).opacity = selected ? .9 : .22;
      figure.halo.scale.setScalar(selected ? 1.16 : 1);
      const idleLike = figure.status === 'idle' || figure.status === 'waiting';
      const doneAge = this.elapsed - (figure.doneAt ?? -Infinity);
      const detailed = figure.detail?.visible !== false;
      if (!moving) {
        this.restoreSeatedFigure(figure);
        // Breathing and a slow swivel of the seated body; the group itself stays exactly on its seat.
        if (figure.torso && detailed) figure.torso.scale.y = 1.07 * (1 + .006 * Math.sin(t * 1.85) * motion);
        if (figure.detail) figure.detail.rotation.y = idleLike && !involvedInDelivery ? Math.sin(t * .35) * .07 * motion : 0;
        figure.head.rotation.z = Math.sin(t * 1.4) * (reading ? .06 : .025) * motion;
        figure.head.rotation.y = figure.status === 'thinking' ? Math.sin(t * .8) * .2 * motion : Math.sin(t * .4) * .08 * motion;
        figure.head.rotation.x = typing ? .1 + Math.sin(t * 2) * .035 * motion : reading ? .13 + Math.sin(t * 2.1) * .07 * motion : 0;
        figure.head.position.y = 1.96 + Math.sin(t * 2) * .012 * motion;
        figure.leftArm.position.z = typing ? .14 : .01;
        figure.rightArm.position.set(.34, 1.4, typing ? .14 : .01);
        figure.leftArm.rotation.z = typing ? -.08 : 0;
        figure.rightArm.rotation.z = typing ? .08 : 0;
        // The employee's local front is +Z; homeYaw turns that front toward the desk at world -Z.
        figure.leftArm.rotation.x = typing ? -1.12 + Math.sin(t * 8.5) * .24 * motion : -.28;
        figure.rightArm.rotation.x = typing ? -1.12 + Math.sin(t * 8.5 + Math.PI) * .24 * motion : -.25;
        if (reading) {
          figure.leftArm.rotation.z = -.12 + Math.sin(t * 2.7) * .18 * motion;
          figure.leftArm.rotation.x = -1.02 + Math.sin(t * 2.7 + .6) * .26 * motion;
          figure.rightArm.rotation.z = .2 + Math.sin(t * 2.1) * .12 * motion;
          figure.rightArm.rotation.x = -1.32 + Math.sin(t * 2.1 + 1) * .2 * motion;
        }
        if (!receiving) {
          figure.paper.visible = reading;
          if (reading) {
            figure.paper.position.set(.26, 1.65 + Math.sin(t * 2.1) * .035 * motion, .37);
            figure.paper.rotation.set(-.14, Math.PI + .06, -.13 + Math.sin(t * 2.1) * .075 * motion);
            // Every so often a page turns and the free hand taps the chin.
            if (motion && figure.flipStartedAt === null && figure.nextFlipAt !== undefined && this.elapsed >= figure.nextFlipAt && !this.paused) figure.flipStartedAt = this.elapsed;
            if (figure.flipStartedAt != null) {
              const k = Math.min(1, (this.elapsed - figure.flipStartedAt) / .4);
              figure.paper.rotation.y += Math.PI * k * k * (3 - 2 * k) * motion;
              if (k >= 1) { figure.flipStartedAt = null; figure.nextFlipAt = this.elapsed + actionDelay(figure.id, 'flip', this.nextActionCycle(figure), 8, 6); }
            }
            if (motion && figure.tapStartedAt === null && figure.nextTapAt !== undefined && this.elapsed >= figure.nextTapAt && !this.paused) figure.tapStartedAt = this.elapsed;
            if (figure.tapStartedAt != null) {
              const k = Math.min(1, (this.elapsed - figure.tapStartedAt) / .8);
              figure.leftArm.rotation.x = -1.02 - .5 * Math.abs(Math.sin(k * Math.PI * 2)) * motion;
              figure.leftArm.rotation.z = -.12 + .3 * Math.sin(k * Math.PI) * motion;
              if (k >= 1) { figure.tapStartedAt = null; figure.nextTapAt = this.elapsed + actionDelay(figure.id, 'tap', this.nextActionCycle(figure), 10, 8); }
            }
          } else { figure.flipStartedAt = null; figure.tapStartedAt = null; }
        }
        if (figure.status === 'approval') {
          figure.rightArm.rotation.z = -2.55 + Math.sin(t * 6) * .2 * motion;
          figure.rightArm.rotation.x = .12;
        }
        if (figure.status === 'error') {
          // Scratching the back of the head instead of the approval wave.
          figure.rightArm.rotation.set(-2.35, 0, -.9 + Math.sin(t * 8.8) * .12 * motion);
        }
        if (figure.status === 'done' && doneAge < 1.5 && motion) {
          const bell = Math.sin(Math.min(1, doneAge / 1.5) * Math.PI);
          figure.leftArm.rotation.x = -.28 - 2.5 * bell;
          figure.rightArm.rotation.x = -.25 - 2.5 * bell;
          figure.leftArm.rotation.z = -.35 * bell;
          figure.rightArm.rotation.z = .35 * bell;
          figure.head.rotation.x = -.15 * bell;
        }
        if (typing && motion) {
          if (figure.reachStartedAt === null && figure.nextReachAt !== undefined && this.elapsed >= figure.nextReachAt && !this.paused) figure.reachStartedAt = this.elapsed;
          if (figure.reachStartedAt != null) {
            const k = Math.min(1, (this.elapsed - figure.reachStartedAt) / 1.2);
            const bell = Math.sin(k * Math.PI);
            figure.rightArm.position.x = .34 + .28 * bell;
            figure.rightArm.rotation.z = .08 - .3 * bell;
            figure.rightArm.rotation.x = -1.12 + Math.sin(t * 8.5 + Math.PI) * .24 * (1 - bell) - .1 * bell;
            if (k >= 1) { figure.reachStartedAt = null; figure.nextReachAt = this.elapsed + actionDelay(figure.id, 'reach', this.nextActionCycle(figure), 12, 8); }
          }
        } else figure.reachStartedAt = null;
        if (idleLike && motion && figure.handMug && figure.yawnStartedAt === null && !involvedInDelivery && !this.approvalRequests.has(figure.id)
          && !(figure.id === 'boss' && this.ownerBusy(figure))) {
          if (figure.sipStartedAt === null && figure.nextSipAt !== undefined && this.elapsed >= figure.nextSipAt && !this.paused) figure.sipStartedAt = this.elapsed;
          if (figure.sipStartedAt != null) {
            const k = Math.min(1, (this.elapsed - figure.sipStartedAt) / 1.6);
            const bell = Math.sin(k * Math.PI);
            figure.rightArm.rotation.x = -.25 - 1.35 * bell;
            figure.rightArm.rotation.z = .08 - .5 * bell;
            figure.rightArm.position.z = .01 + .12 * bell;
            figure.handMug.visible = k < 1;
            if (k >= 1) { figure.sipStartedAt = null; figure.nextSipAt = this.elapsed + actionDelay(figure.id, 'sip', this.nextActionCycle(figure), 40, 30); }
          }
        } else if (figure.handMug) { figure.handMug.visible = false; figure.sipStartedAt = null; }
        // Paper-plane moments: the sender pushes off, the recipient turns to follow and raises a hand to catch.
        if (figure.pushUntil !== undefined && this.elapsed < figure.pushUntil && motion) {
          const k = (figure.pushUntil - this.elapsed) / .4;
          figure.rightArm.rotation.x = -1.7 + .5 * (1 - k);
          figure.rightArm.rotation.z = -.2;
        }
        if (figure.catchUntil !== undefined && this.elapsed < figure.catchUntil && motion) figure.rightArm.rotation.set(-1.9, 0, -.6);
        if (figure.lookYaw != null && motion) {
          const relative = Math.atan2(Math.sin(figure.lookYaw - figure.group.rotation.y), Math.cos(figure.lookYaw - figure.group.rotation.y));
          if (Math.abs(relative) < 1.3) figure.head.rotation.y = THREE.MathUtils.clamp(relative, -.7, .7);
        }
        // An external call briefly takes over typing or reading; approval and error end it before this point.
        const calling = figure.callBlend !== undefined ? this.applyCallPose(figure, delta, motion) : 0;
        if (calling > .5 && !receiving) figure.paper.visible = false;
        if (figure.id === 'boss' && this.elapsed < this.stampUntil) {
          figure.rightArm.position.z = .14;
          figure.rightArm.rotation.z = .03;
          figure.rightArm.rotation.x = -1.35 + Math.sin((this.stampUntil - this.elapsed) * Math.PI * 2) * .24 * motion;
          figure.head.rotation.x = .15;
          if (figure.approvalStamp) figure.approvalStamp.rotation.x = -figure.rightArm.rotation.x;
        } else if (figure.id === 'boss' && figure.nodUntil !== undefined && this.elapsed < figure.nodUntil && motion) {
          figure.head.rotation.x = .2 * Math.abs(Math.sin((figure.nodUntil - this.elapsed) / .8 * Math.PI * 2));
        }
        if (figure.id === 'boss') this.updateOwnerPose(figure, delta, motion, idleLike, involvedInDelivery);
        if (figure.yawnStartedAt !== null) {
          const strength = yawnStrength(this.elapsed - figure.yawnStartedAt);
          figure.head.rotation.x = -.24 * strength;
          figure.head.rotation.y *= 1 - strength;
          figure.head.rotation.z *= 1 - strength;
          figure.rightArm.position.set(.34 - .22 * strength, 1.4 + .24 * strength, .01 + .19 * strength);
          figure.rightArm.rotation.set(-.25 - 1.9 * strength, 0, -.45 * strength);
          if (figure.yawnMouth) figure.yawnMouth.visible = strength > .2;
          if (figure.smile) figure.smile.visible = strength <= .2;
          for (const eye of figure.eyes ?? []) eye.scale.y = 1.13 * (1 - .85 * strength);
        } else {
          if (detailed) this.applyExpression(figure, calling > .5 ? 'call' : typing ? 'working' : reading ? 'thinking' : figure.status === 'approval' ? 'approval'
            : figure.status === 'error' ? 'error' : figure.status === 'done' && doneAge >= 1.5 && doneAge < 3 ? 'done' : 'idle', motion);
        }
      }
      if (figure.phone && detailed) this.updatePhoneScreen(figure, motion);
      if (figure.ponytail && detailed) {
        const target = -figure.head.rotation.y * .6 * motion;
        figure.ponytail.rotation.y += (target - figure.ponytail.rotation.y) * (motion ? 1 - Math.exp(-delta / .2) : 1);
      }
      if (figure.steam) {
        const puffing = typing && !moving && motion === 1 && detailed;
        for (const [index, puff] of figure.steam.entries()) {
          puff.visible = puffing;
          if (!puffing) continue;
          const phase = ((this.elapsed + index * .4) % 1.2) / 1.2;
          puff.position.y = 1.62 + phase * .3;
          puff.scale.setScalar(1 - phase * .8);
        }
        const steamMaterial = figure.steam[0]?.material as THREE.MeshStandardMaterial | undefined;
        if (steamMaterial) steamMaterial.opacity = puffing ? .55 : 0;
      }
      if (figure.lampGlow) figure.lampGlow.visible = reading && !moving;
      for (const [index, dot] of figure.signal.children.entries()) {
        dot.position.y = Math.sin(t * 3.5 - index * .75) * .05 * motion;
        dot.scale.setScalar(figure.status === 'approval' ? 1.2 : 1);
      }
    }
  }

  private updateAnimation(rawDelta: number): void {
    if (this.suspended) return;
    const delta = this.paused ? 0 : Math.max(0, Math.min(rawDelta, .25)) * this.speed;
    this.elapsed += delta;
    this.syncApprovalPile();
    this.updateFigures(delta);
    if (delta > 0) { this.updateDeliveries(delta); this.updateApprovalVisits(delta); this.updatePaperFlights(delta); }
    // Phones are placed after walks and visits have moved their bodies this frame, so a desk phone never trails a walker.
    for (const figure of this.figures) {
      if (figure.phone && figure.group.visible && figure.detail?.visible !== false) this.placePhone(figure);
    }
  }

  /**
   * One prepared sheet per current approval request lies in the owner's tray; a clip marks more requests than sheets.
   * The host's company-wide count wins once set; otherwise the tray counts this room's seated requests.
   */
  private syncApprovalPile(): void {
    const pile = this.approvalPile;
    if (!pile) return;
    const count = this.approvalCount ?? this.approvalRequests.size;
    if (count === pile.count) return;
    pile.count = count;
    for (const [index, sheet] of pile.sheets.entries()) sheet.visible = index < count;
    pile.clip.visible = count > pile.sheets.length;
  }

  private clockSeconds(): number { return performance.now() / 1000; }

  /** Window light blends and LED blinks stop for reduced motion, power saving and crowded floors; static decor stays. */
  private ambientMotionOff(): boolean {
    return !!this.reducedMotion || !!this.powerSaving || this.visibleFigureCount() > 30;
  }

  /** Counts shown people without allocating, so per-event and per-frame checks stay cheap at 512 staff. */
  private visibleFigureCount(): number {
    let count = 0;
    for (const figure of this.figures) if (figure.group.visible) count++;
    return count;
  }

  /** Window glass and the floor light patch follow the local clock and are recolored only when the minute changes. */
  private updateWindowLight(date = new Date()): void {
    const glass = this.windowGlass, patch = this.windowPatch;
    if (!glass || !patch) return;
    const minute = date.getHours() * 60 + date.getMinutes();
    if (minute === this.windowMinute) return;
    this.windowMinute = minute;
    const { from, to, blend } = windowLightAt(minute, !this.ambientMotionOff());
    const previous = WINDOW_LIGHT[from], next = WINDOW_LIGHT[to];
    glass.color.set(previous.glass).lerp(windowScratch.set(next.glass), blend);
    patch.color.set(previous.patch).lerp(windowScratch.set(next.patch), blend);
    patch.opacity = previous.patchOpacity + (next.patchOpacity - previous.patchOpacity) * blend;
  }

  /** Writes the LED material only when its reported state or flash changes. */
  private updateRouterLed(now = this.clockSeconds()): void {
    const material = this.routerLedMaterial;
    if (!material) return;
    const state = this.bridgeConnected ?? null;
    const color = state === null ? STATUS_STYLE.idle.color : state ? ROUTER_LED_COLORS.connected : ROUTER_LED_COLORS.disconnected;
    const flashing = state === true && (now - (this.routerPulseAt ?? -Infinity) < ROUTER_FLASH_SECONDS
      || routerReconnectFlash(now - (this.routerReconnectAt ?? -Infinity)));
    const key = `${color}/${flashing}`;
    if (key === this.routerLedKey) return;
    this.routerLedKey = key;
    material.color.set(color);
    material.emissive.set(color);
    material.emissiveIntensity = flashing ? 1.8 : state === null ? .15 : .65;
    this.routerLed?.scale.setScalar(flashing ? 1.4 : 1);
  }

  private updateDeskWork(): void {
    // Detailed props have a fixed budget; every other employee retains an instanced work symbol.
    const detailedIds = this.detailedWorkIds ??= new Set<string>();
    const pixelsPerUnit = this.container.clientHeight / (this.camera.top - this.camera.bottom);
    const detailTime = performance.now() / 1000;
    const detailKey = `${this.buildingView}:${this.focusId}:${Math.round(pixelsPerUnit)}`;
    if (detailKey !== this.lastWorkDetailKey || detailTime - (this.lastWorkDetailAt ?? -Infinity) >= .5) {
      this.lastWorkDetailAt = detailTime; this.lastWorkDetailKey = detailKey;
      detailedIds.clear();
      if (!this.buildingView) {
        const candidates = this.figures.filter(figure => figure.group.visible && figure.id !== 'boss'
          && (isWorkingStatus(figure.status) || figure.status === 'error' || figure.deskWork?.frame(this.elapsed).main));
        candidates.sort((a, b) => Number(b.id === this.focusId) - Number(a.id === this.focusId)
          || a.origin.distanceToSquared(this.cameraTarget) - b.origin.distanceToSquared(this.cameraTarget));
        for (const figure of candidates.slice(0, 12)) {
          if (pixelsPerUnit >= 12 || figure.id === this.focusId) detailedIds.add(figure.id);
        }
      }
    }
    let count = 0;
    const kinds = new Set<string>();
    for (const figure of this.figures) {
      if (!figure.deskWork) continue;
      // Props belong to the desk, not the walking employee. Explicit visits have priority.
      const away = this.approvalVisits.has(figure.id) || this.deliveries.some(delivery => delivery.courier === figure);
      const anchor = this.workAnchor ?? new THREE.Vector3();
      figure.screen.getWorldPosition(anchor);
      figure.deskWork.group.position.copy(anchor);
      const frame = figure.deskWork.update(this.elapsed, { detail: figure.group.visible && !this.buildingView && detailedIds.has(figure.id),
        reducedMotion: this.reducedMotion, paused: this.paused, away });
      if (frame.main) kinds.add(frame.main);
      figure.bubble.dataset.workKind = frame.main ?? '';
      figure.bubble.dataset.workAuxiliary = frame.auxiliary ?? '';
      if (figure.deskWork.group.visible) count++;
    }
    const cardSeat = this.cardOpenId ? this.agentSeats.get(this.cardOpenId) : undefined;
    const cardFigure = cardSeat === undefined ? undefined : this.figures[cardSeat];
    this.workMarkers?.update(this.figures, this.elapsed, this.focusId, this.reducedMotion, detailedIds,
      cardFigure && cardFigure.group.visible && this.cardHidesMarkers(cardFigure) ? cardFigure.id : null,
      this.yaw + (this.motion?.offset.yaw ?? 0));
    this.container.dataset.workProps = String(count);
    this.container.dataset.workKinds = [...kinds].sort().join(',');
  }

  /** A CSS custom property given in px (0 when absent, in another unit, or outside a browser DOM). */
  private static pixelVariable(element: unknown, name: string): number {
    try {
      if (typeof getComputedStyle !== 'function' || typeof (element as { nodeType?: unknown } | null)?.nodeType !== 'number') return 0;
      const match = /^\s*(\d+(?:\.\d+)?)px\s*$/u.exec(getComputedStyle(element as Element).getPropertyValue(name));
      return match ? Number(match[1]) : 0;
    } catch { return 0; }
  }

  /**
   * Fits the whole building between the HUD insets at zoom 1: the largest scale that keeps every silhouette point (and the
   * ground-floor plate with its height) inside the free area, and the view offset that centres the model there. While the ambient
   * drift can move, the automatic shot keeps one scale for every pose of the drift share it uses (FRAME_DRIFT_SHARES), and only
   * the offset follows the drawn pose, so the model stays whole without breathing in size; a still shot fits its own pose. After
   * a manual orbit the previous pose, share and scale stay. A stand-in building without silhouette points fits its bounding sphere.
   * Where the page also reports the insets beside the floor caption, the fit uses them while `chooseBesideCaption` holds.
   */
  private fitBuildingFrame(building: BuildingOverview, width: number, height: number): void {
    const automatic = this.manualProjectionBase === undefined || this.frameYaw === undefined;
    if (automatic) { this.frameBaseYaw = this.yaw; this.frameBaseElevation = this.elevation; }
    const below = this.limitFrameArea(this.hudInsets, width, height, this.frameAreaBelow ??= { top: 0, right: 0, bottom: 0, left: 0 });
    const reported = this.hudInsetsBeside;
    const beside = reported ? this.limitFrameArea(reported, width, height, this.frameAreaBeside ??= { top: 0, right: 0, bottom: 0, left: 0 }, false) : null;
    const count = Math.min(building.framePoints?.length ?? 0, building.frameCount ?? 0, FRAME_POINT_LIMIT - 1);
    // The drift share, its shared scale and the caption decision depend only on these inputs, never on the drift itself:
    // recomputed on change only, so the decision cannot flip from one frame to the next.
    if (this.frameInputsChanged(building, count, width, height, below, beside)) {
      this.fitDriftScale(building, count, width, height, below);
      this.frameBeside = !!beside && !!reported && this.chooseBesideCaption(building, count, width, height, below, beside, reported);
    }
    const chosen = this.frameBeside && beside ? beside : below;
    const area = this.frameArea ??= { top: 0, right: 0, bottom: 0, left: 0 };
    area.top = chosen.top; area.right = chosen.right; area.bottom = chosen.bottom; area.left = chosen.left;
    const top = area.top, left = area.left;
    const freeWidth = Math.max(1, width - left - area.right), freeHeight = Math.max(1, height - top - area.bottom);
    const fitWidth = Math.max(1, freeWidth - 2 * OfficeScene.framePadding(freeWidth, count));
    const fitHeight = Math.max(1, freeHeight - 2 * OfficeScene.framePadding(freeHeight, count));
    if (automatic) {
      const drift = this.motion?.offset, share = this.frameDriftShare ?? 1;
      this.frameYaw = this.yaw + (drift?.yaw ?? 0) * share;
      this.frameElevation = THREE.MathUtils.clamp(this.elevation + (drift?.elevation ?? 0) * share - .28, .25, 1.3);
    }
    const n = this.projectFramePose(building, count, this.frameYaw!, this.frameElevation);
    const scale = this.driftCanMove() ? this.frameDriftScale : this.projectedFrameScale(n, fitWidth, fitHeight, building.radius, height);
    const extent = this.measureFramePose(n, scale);
    this.frameBase = height / (2 * scale);
    // The camera target sits at the image centre; move the image so the model's pixel extents centre in the free area.
    this.frameOffsetX = width / 2 - (left + freeWidth / 2 - (extent[0]! + extent[1]!) / 2);
    this.frameOffsetY = height / 2 - (top + freeHeight / 2 - (extent[2]! + extent[3]!) / 2);
  }

  /** True while the ambient camera drift may still move: the automatic camera is on and motion is not reduced. */
  private driftCanMove(): boolean { return this.autoRotate && !this.reducedMotion; }

  /** Stores one building fit input in the cache key; true when it differs from the stored value. */
  private storeFrameKey(index: number, value: number): boolean {
    const key = this.frameKey!;
    if (key[index] === value) return false;
    key[index] = value;
    return true;
  }

  /** Pixels kept clear at each end of a free span of `span` px (none for a stand-in building without silhouette points). */
  private static framePadding(span: number, count: number): number {
    return count ? THREE.MathUtils.clamp(span * FRAME_PADDING_SHARE, FRAME_PADDING_MIN, FRAME_PADDING) : 0;
  }

  /**
   * Writes `insets` (or, without them, the bottom clearance alone) into `out` after the share limits of the window; with `sides`
   * false the side insets stay whole (the fit beside the floor caption).
   */
  private limitFrameArea(insets: HudInsets | null, width: number, height: number, out: HudInsets, sides = true): HudInsets {
    let top = insets?.top ?? 0, bottom = insets ? insets.bottom : this.hudClearancePx || 0;
    let left = insets?.left ?? 0, right = insets?.right ?? 0;
    if (top + bottom > height * FRAME_MAX_VERTICAL_INSET) { const share = height * FRAME_MAX_VERTICAL_INSET / (top + bottom); top *= share; bottom *= share; }
    if (sides && left + right > width * FRAME_MAX_HORIZONTAL_INSET) { const share = width * FRAME_MAX_HORIZONTAL_INSET / (left + right); left *= share; right *= share; }
    out.top = top; out.right = right; out.bottom = bottom; out.left = left;
    return out;
  }

  /** Sets the drift share and the scale its poses share for a fit into `area` (see FRAME_DRIFT_SHARES). */
  private fitDriftScale(building: BuildingOverview, count: number, width: number, height: number, area: HudInsets): void {
    const freeWidth = Math.max(1, width - area.left - area.right), freeHeight = Math.max(1, height - area.top - area.bottom);
    const fitWidth = Math.max(1, freeWidth - 2 * OfficeScene.framePadding(freeWidth, count));
    const fitHeight = Math.max(1, freeHeight - 2 * OfficeScene.framePadding(freeHeight, count));
    const turn = CINEMATIC_PROFILES.building.yaw, tilt = CINEMATIC_PROFILES.building.elevation;
    for (let s = 0; s < FRAME_DRIFT_SHARES.length; s++) {
      const share = FRAME_DRIFT_SHARES[s]!;
      let smallest = Infinity, largest = 0;
      for (let a = 0; a < FRAME_DRIFT_YAW_STEPS.length; a++) {
        for (let b = 0; b < FRAME_DRIFT_TILT_STEPS.length; b++) {
          const n = this.projectFramePose(building, count, this.frameBaseYaw + FRAME_DRIFT_YAW_STEPS[a]! * share * turn,
            THREE.MathUtils.clamp(this.frameBaseElevation + FRAME_DRIFT_TILT_STEPS[b]! * share * tilt - .28, .25, 1.3));
          const scale = this.projectedFrameScale(n, fitWidth, fitHeight, building.radius, height);
          smallest = Math.min(smallest, scale); largest = Math.max(largest, scale);
        }
      }
      this.frameDriftShare = share; this.frameDriftScale = smallest;
      if (largest <= smallest * FRAME_DRIFT_SPREAD) break;
    }
  }

  /**
   * Decision 53: the floor caption only takes the top left corner, so in a short window it may count as a left block and the
   * building fits under the higher HUD edge beside it. That holds while the free height below the caption is short, the share
   * limits keep the raised top edge, the fit beside the caption is clearly larger, and the column between the caption's edge (the
   * reported `beside.left`) and the right block beside it keeps the nameplate column of that larger model clear of the right
   * block, so even number-only plates never reach under the usage HUD. Each test is looser for staying than for entering
   * (FRAME_BESIDE_*). The column is the one the page reports, never narrowed by a share limit.
   * Called with the drift share and scale of the fit below the caption in place; leaves those of the chosen fit.
   */
  private chooseBesideCaption(building: BuildingOverview, count: number, width: number, height: number, below: HudInsets, beside: HudInsets,
    reported: HudInsets): boolean {
    const stay = this.frameBeside ? 1 : 0, freeHeight = height - below.top - below.bottom;
    if (!(freeHeight < FRAME_BESIDE_BAND[stay]) || beside.top < reported.top - .5) return false;
    const belowShare = this.frameDriftShare, belowScale = this.frameDriftScale;
    this.fitDriftScale(building, count, width, height, beside);
    // The model's extents stand centred in the column; its plates start at the side wall and need their reserve right of it.
    const half = (width - beside.left - beside.right) / 2, reserve = (building.plateColumnReserve ?? 0) + FRAME_BESIDE_COLUMN[stay];
    if (this.frameDriftScale >= belowScale * FRAME_BESIDE_GAIN[stay] && this.besidePlateReach(building, count, width, height, beside) + reserve <= half) return true;
    this.frameDriftShare = belowShare; this.frameDriftScale = belowScale;
    return false;
  }

  /**
   * How far right of the centre of the model's extents the nameplate column starts (the outer side wall's rightmost projected corner,
   * where `BuildingOverview.updateLabels` places it), in px of the fit into `area`: the most over the drift poses at their shared
   * scale and the still pose at its own (larger) scale, since the caption decision holds whether or not the drift moves. Only the
   * horizontal screen axis matters, which the elevation does not change. Runs on input changes only, without allocation.
   */
  private besidePlateReach(building: BuildingOverview, count: number, width: number, height: number, area: HudInsets): number {
    const freeWidth = Math.max(1, width - area.left - area.right), freeHeight = Math.max(1, height - area.top - area.bottom);
    const fitWidth = Math.max(1, freeWidth - 2 * OfficeScene.framePadding(freeWidth, count));
    const fitHeight = Math.max(1, freeHeight - 2 * OfficeScene.framePadding(freeHeight, count));
    const share = this.frameDriftShare ?? 0, turn = CINEMATIC_PROFILES.building.yaw, tilt = CINEMATIC_PROFILES.building.elevation;
    const halfWidth = building.plateWallHalfWidth ?? 0, halfDepth = building.plateWallHalfDepth ?? 0, center = building.center, u = this.frameU!;
    const poses = FRAME_DRIFT_YAW_STEPS.length * FRAME_DRIFT_TILT_STEPS.length;
    let reach = 0;
    // Pose -1 is the still pose; the others are the drift poses of the current share.
    for (let pose = -1; pose < poses; pose++) {
      const a = Math.floor(pose / FRAME_DRIFT_TILT_STEPS.length), b = pose % FRAME_DRIFT_TILT_STEPS.length;
      const yaw = this.frameBaseYaw + (pose < 0 ? 0 : FRAME_DRIFT_YAW_STEPS[a]! * share * turn);
      const elevation = THREE.MathUtils.clamp(this.frameBaseElevation + (pose < 0 ? 0 : FRAME_DRIFT_TILT_STEPS[b]! * share * tilt) - .28, .25, 1.3);
      const n = this.projectFramePose(building, count, yaw, elevation);
      const scale = pose < 0 ? this.projectedFrameScale(n, fitWidth, fitHeight, building.radius, height) : this.frameDriftScale;
      let low = Infinity, high = -Infinity;
      for (let i = 0; i < n; i++) { low = Math.min(low, u[i]!); high = Math.max(high, u[i]!); }
      const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
      // Screen right is x cos(yaw) - z sin(yaw) around the building centre; the wall corners stand at +-halfWidth, +-halfDepth.
      const wall = halfWidth * Math.abs(cosYaw) + halfDepth * Math.abs(sinYaw) - center.x * cosYaw + center.z * sinYaw;
      reach = Math.max(reach, (wall - (low + high) / 2) * scale);
    }
    return reach;
  }

  /** Records the inputs the drift share, its scale and the caption decision depend on (after the share limits); true when any changed. */
  private frameInputsChanged(building: BuildingOverview, count: number, width: number, height: number, below: HudInsets, beside: HudInsets | null): boolean {
    this.frameKey ??= new Float64Array(FRAME_KEY_LENGTH);
    const center = building.center, points = building.framePoints, plate = count ? building.groundPlateAnchor : null;
    let changed = !this.frameKeyValid, i = 0;
    this.frameKeyValid = true;
    changed = this.storeFrameKey(i++, width) || changed;
    changed = this.storeFrameKey(i++, height) || changed;
    changed = this.storeFrameKey(i++, below.top) || changed;
    changed = this.storeFrameKey(i++, below.right) || changed;
    changed = this.storeFrameKey(i++, below.bottom) || changed;
    changed = this.storeFrameKey(i++, below.left) || changed;
    changed = this.storeFrameKey(i++, beside ? 1 : 0) || changed;
    changed = this.storeFrameKey(i++, beside?.top ?? 0) || changed;
    changed = this.storeFrameKey(i++, beside?.right ?? 0) || changed;
    changed = this.storeFrameKey(i++, beside?.bottom ?? 0) || changed;
    changed = this.storeFrameKey(i++, beside?.left ?? 0) || changed;
    changed = this.storeFrameKey(i++, this.frameBaseYaw) || changed;
    changed = this.storeFrameKey(i++, this.frameBaseElevation) || changed;
    changed = this.storeFrameKey(i++, count) || changed;
    changed = this.storeFrameKey(i++, count ? 0 : building.radius || 0) || changed;
    changed = this.storeFrameKey(i++, plate ? 1 : 0) || changed;
    for (let p = 0; p <= count; p++) {
      const point = p < count ? points[p]! : plate;
      changed = this.storeFrameKey(i++, point ? point.x - center.x : 0) || changed;
      changed = this.storeFrameKey(i++, point ? point.y - center.y : 0) || changed;
      changed = this.storeFrameKey(i++, point ? point.z - center.z : 0) || changed;
    }
    return changed;
  }

  /**
   * Projects the silhouette (and the ground-floor plate) for one building camera pose into the reused screen-axis arrays, in world
   * units around the building centre, and returns how many points were written. Runs every frame of a transition: no allocation.
   */
  private projectFramePose(building: BuildingOverview, count: number, yaw: number, elevation: number): number {
    const u = this.frameU ??= new Float64Array(FRAME_POINT_LIMIT), v = this.frameV ??= new Float64Array(FRAME_POINT_LIMIT);
    const pad = this.framePad ??= new Float64Array(FRAME_POINT_LIMIT);
    if (!count) {
      const r = Math.max(1, building.radius);
      u[0] = -r; v[0] = 0; u[1] = r; v[1] = 0; u[2] = 0; v[2] = -r; u[3] = 0; v[3] = r;
      pad[0] = pad[1] = pad[2] = pad[3] = 0;
      return 4;
    }
    // Screen axes of the orthographic building camera (lookAt with world up): right = (cos yaw, 0, -sin yaw).
    const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw);
    const upX = -Math.sin(elevation) * sinYaw, upY = Math.cos(elevation), upZ = -Math.sin(elevation) * cosYaw;
    const center = building.center, points = building.framePoints, plate = building.groundPlateAnchor;
    let n = 0;
    for (let i = 0; i < count + (plate ? 1 : 0); i++) {
      const point = i < count ? points[i]! : plate!;
      const x = point.x - center.x, y = point.y - center.y, z = point.z - center.z;
      u[n] = x * cosYaw - z * sinYaw; v[n] = x * upX + y * upY + z * upZ; pad[n++] = i < count ? 0 : PLATE_HALF_HEIGHT;
    }
    return n;
  }

  /** Pixels per world unit at which the projected points fit the box: every pair, the higher one's margin above and the lower one's below. */
  private projectedFrameScale(n: number, fitWidth: number, fitHeight: number, radius: number, height: number): number {
    const u = this.frameU!, v = this.frameV!, pad = this.framePad!;
    let scale = Infinity;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const du = u[i]! - u[j]!, dv = v[i]! - v[j]!;
        if (du > 1e-9) scale = Math.min(scale, fitWidth / du);
        if (dv > 1e-9) scale = Math.min(scale, Math.max(1, fitHeight - pad[i]! - pad[j]!) / dv);
      }
    }
    return scale > 0 && Number.isFinite(scale) ? scale : height / (2 * Math.max(1, radius));
  }

  /** Pixel extents of the projected points at `scale` around the image centre (y down), vertical margins included. */
  private measureFramePose(n: number, scale: number): Float64Array {
    const u = this.frameU!, v = this.frameV!, pad = this.framePad!, extent = this.frameExtent ??= new Float64Array(4);
    extent[0] = Infinity; extent[1] = -Infinity; extent[2] = Infinity; extent[3] = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = u[i]! * scale, y = -v[i]! * scale;
      extent[0] = Math.min(extent[0]!, x); extent[1] = Math.max(extent[1]!, x);
      extent[2] = Math.min(extent[2]!, y - pad[i]!); extent[3] = Math.max(extent[3]!, y + pad[i]!);
    }
    return extent;
  }

  /**
   * Camera target and zoom of a floor approach in the building view (automatic watching, a clicked or stepped focus floor, the
   * crane's start): writes the target into `targetGoal` and returns the zoom. The target moves from the building centre toward
   * the floor only as far as the whole model, rooftop sign and ground plate included, stays on screen at zoom 1 in every pose the
   * drift can take; a shot fitted beside the floor caption (decision 53) already fills a short window, so a low floor of a tall
   * building is approached only part of the way there. The zoom is at most BUILDING_FOCUS_ZOOM, lowered so the model stays on
   * screen around that target (never below the whole-building scale). Runs when a shot is chosen, not per frame.
   */
  private aimBuildingApproach(projectId: string): number {
    const building = this.building;
    this.approachId = projectId;
    if (!building) return 1;
    const point = building.focusPoint(projectId);
    if (!projectId) { this.targetGoal.copy(point); return 1; }
    const width = Math.max(this.container.clientWidth, 1), height = Math.max(this.container.clientHeight, 1);
    this.fitBuildingFrame(building, width, height);
    const area = this.frameArea!, count = Math.min(building.framePoints?.length ?? 0, building.frameCount ?? 0, FRAME_POINT_LIMIT - 1);
    const freeWidth = Math.max(1, width - area.left - area.right), freeHeight = Math.max(1, height - area.top - area.bottom);
    const focus = point.clone().sub(building.center);
    const moving = this.driftCanMove(), share = this.frameDriftShare ?? 1;
    const turn = CINEMATIC_PROFILES.building.yaw, tilt = CINEMATIC_PROFILES.building.elevation, pad = this.framePad!;
    const right = width - FRAME_PADDING_MIN, bottom = height - FRAME_PADDING_MIN;
    let reach = 1, zoom = BUILDING_FOCUS_ZOOM;
    // First pass, beside the caption only: the share of the way to the floor at zoom 1. The shot below the caption leaves that
    // room around the model, so it always goes the whole way. Second pass: the zoom around the target that share gives.
    for (let pass = this.frameBeside ? 0 : 1; pass < 2; pass++) {
      for (let a = 0; a < (moving ? FRAME_DRIFT_YAW_STEPS.length : 1); a++) {
        for (let b = 0; b < (moving ? FRAME_DRIFT_TILT_STEPS.length : 1); b++) {
          const yaw = moving ? this.frameBaseYaw + FRAME_DRIFT_YAW_STEPS[a]! * share * turn : this.frameYaw!;
          const elevation = moving ? THREE.MathUtils.clamp(this.frameBaseElevation + FRAME_DRIFT_TILT_STEPS[b]! * share * tilt - .28, .25, 1.3)
            : this.frameElevation;
          const n = this.projectFramePose(building, count, yaw, elevation), u = this.frameU!, v = this.frameV!;
          const scale = moving ? this.frameDriftScale : height / (2 * this.frameBase), extent = this.measureFramePose(n, scale);
          // The fit's offset draws the camera target here; zooming onto the focus floor scales the model around that pixel.
          const targetX = area.left + freeWidth / 2 - (extent[0]! + extent[1]!) / 2, targetY = area.top + freeHeight / 2 - (extent[2]! + extent[3]!) / 2;
          const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw), sinElevation = Math.sin(elevation);
          const focusU = focus.x * cosYaw - focus.z * sinYaw;
          const focusV = -focus.x * sinElevation * sinYaw + focus.y * Math.cos(elevation) - focus.z * sinElevation * cosYaw;
          for (let i = 0; i < n; i++) {
            if (pad[i]) continue;
            if (pass === 0) {
              // At zoom 1 the whole way moves every point by (dx, dy) px; a share of the way moves it by that share.
              const x = targetX + u[i]! * scale, y = targetY - v[i]! * scale, dx = -focusU * scale, dy = focusV * scale;
              if (dx > 1e-9) reach = Math.min(reach, (right - x) / dx);
              else if (dx < -1e-9) reach = Math.min(reach, (x - FRAME_PADDING_MIN) / -dx);
              if (dy > 1e-9) reach = Math.min(reach, (bottom - y) / dy);
              else if (dy < -1e-9) reach = Math.min(reach, (y - FRAME_PADDING_MIN) / -dy);
              continue;
            }
            const x = (u[i]! - reach * focusU) * scale, y = -(v[i]! - reach * focusV) * scale;
            if (x > 1e-9) zoom = Math.min(zoom, (right - targetX) / x);
            else if (x < -1e-9) zoom = Math.min(zoom, (targetX - FRAME_PADDING_MIN) / -x);
            if (y > 1e-9) zoom = Math.min(zoom, (bottom - targetY) / y);
            else if (y < -1e-9) zoom = Math.min(zoom, (targetY - FRAME_PADDING_MIN) / -y);
          }
        }
      }
      if (pass === 0) reach = THREE.MathUtils.clamp(reach, 0, 1);
    }
    if (reach >= 1) this.targetGoal.copy(point);
    else this.targetGoal.copy(building.center).addScaledVector(focus, reach);
    return THREE.MathUtils.clamp(zoom, 1, BUILDING_FOCUS_ZOOM);
  }

  /** Aims the automatic approach again after the caption decision changed the fit's scale; a manual camera keeps its own shot. */
  private refitBuildingApproach(): void {
    if (typeof this.approachId !== 'string' || this.manualProjectionBase !== undefined) return;
    this.zoomGoal = this.aimBuildingApproach(this.approachId); this.automaticZoom = this.zoomGoal;
    // A running glide continues from its start toward the new goal; a finished one takes the new zoom at once.
    if (!this.cinematic) this.cameraZoom = this.zoomGoal;
  }

  private resize(updateSurface = true): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const aspect = width / height;
    if (updateSurface) this.hudClearancePx = OfficeScene.pixelVariable(this.container, '--hud-clearance');
    const building = this.buildingView ? this.building : undefined;
    if (building) {
      const beside = this.frameBeside === true;
      this.fitBuildingFrame(building, width, height);
      if (beside !== this.frameBeside) this.refitBuildingApproach();
    }
    const roomRadius = Math.hypot(this.bounds.width, this.bounds.depth) * .54;
    // Overview fits an expanded floor, or the whole building between the HUD blocks; close-up uses a fixed room scale so a person
    // stays legible at 512 seats.
    const fitted = building ? this.frameBase : Math.max(roomRadius, roomRadius / aspect);
    const base = this.manualProjectionBase ?? THREE.MathUtils.lerp(fitted, Math.max(10.65, 14.2 / aspect), this.framing);
    const halfHeight = base / this.cameraZoom;
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    // The building model centres in the free area between the HUD blocks. A view offset moves the image only, so the frustum
    // scale, targets and picking rays (which unproject through the same projection matrix) stay consistent.
    if (building && (this.frameOffsetX || this.frameOffsetY)) this.camera.setViewOffset(width, height, this.frameOffsetX, this.frameOffsetY, width, height);
    else if (this.camera.view?.enabled) this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (updateSurface) {
      this.renderer.setSize(width, height);
      this.requestHiddenFrame();
    }
  }

  /** WKWebView can load while hidden with no rAF callbacks. Keep a current still image without a background loop. */
  private requestHiddenFrame(): void {
    if (this.disposed || this.suspended || this.hiddenFramePending || typeof document === 'undefined' || !document.hidden) return;
    this.hiddenFramePending = true;
    queueMicrotask(() => {
      this.hiddenFramePending = false;
      if (this.disposed || this.suspended || typeof document === 'undefined' || !document.hidden) return;
      this.lastFrameTime = null;
      this.container.dataset.animationState = 'hidden';
      this.drawSceneFrame(0, performance.now());
    });
  }

  private syncRenderLoop(): void {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.animationId = 0;
    this.lastFrameTime = null;
    if (this.disposed) return;
    const hidden = document.hidden;
    this.container.dataset.animationState = hidden ? 'hidden' : this.suspended ? 'overview' : 'running';
    if (hidden || this.suspended) {
      this.cancelPointers();
      this.requestHiddenFrame();
      return;
    }
    this.animationId = requestAnimationFrame(this.animate);
  }

  private updateCamera(rawDelta: number, now: number): void {
    if (this.paused && this.cinematic) return;
    if (this.following && this.focusId !== null) {
      const index = this.agentSeats.get(this.focusId);
      const figure = index === undefined ? undefined : this.figures[index];
      if (figure) this.targetGoal.copy(figure.group.position).add(new THREE.Vector3(0, 1.15, 0));
    }
    this.motion ??= createCinematicMotionState();
    this.motion = stepCinematicMotion(this.motion, { kind: this.buildingView ? 'building' : this.following ? 'employee' : 'room',
      deltaSeconds: rawDelta, nowMs: now, enabled: this.autoRotate && now >= this.autoRotateAfter,
      paused: this.paused, reducedMotion: this.reducedMotion, interacting: this.cameraPointers.active });
    if (this.cinematic) {
      const duration = this.cinematicSeconds ?? 2.6;
      this.cinematicElapsed = Math.min(duration, this.cinematicElapsed + rawDelta);
      const t = this.cinematicElapsed / duration;
      const ease = t * t * (3 - 2 * t);
      this.cameraTarget.lerpVectors(this.cinematicStartTarget, this.targetGoal, ease);
      this.cameraZoom = THREE.MathUtils.lerp(this.cinematicStartZoom, this.zoomGoal, ease);
      this.framing = THREE.MathUtils.lerp(this.cinematicStartFraming, this.framingGoal, ease);
      this.resize(false);
      if (t >= 1) { this.cinematic = false; this.cinematicSeconds = undefined; }
    } else this.cameraTarget.lerp(this.targetGoal, this.reducedMotion ? 1 : Math.min(1, rawDelta * 6));
    const radius = Math.max(60, this.buildingView && this.building ? this.building.radius * 2.5 : Math.hypot(this.bounds.width, this.bounds.depth) * 1.2);
    const offset = this.motion.offset;
    // The building shot draws the share of the drift its fit allows (one scale for all of those poses; see FRAME_DRIFT_SHARES).
    const building = this.buildingView && !!this.building, share = building ? this.frameDriftShare ?? 1 : 1;
    let yaw = this.yaw + offset.yaw * share;
    let elevation = THREE.MathUtils.clamp(this.elevation + offset.elevation * share - (this.buildingView ? .28 : 0), .25, 1.3);
    const span = (this.buildingView && this.building ? this.building.radius : this.following ? 12 : Math.min(45, Math.max(this.bounds.width, this.bounds.depth))) * share;
    const target = this.cameraTarget.clone().add(new THREE.Vector3(offset.targetX, offset.targetY, offset.targetZ).multiplyScalar(span));
    // The automatic building shot moves its view offset with every drift pose at the shared scale. Its fit is tight, so the
    // drift's optical zoom stays out of the building view: the model never grows past the free area or shrinks away from it.
    if (building && this.manualProjectionBase === undefined && (yaw !== this.frameYaw || elevation !== this.frameElevation)) {
      this.resize(false);
      // A changed fit input can change the drift share; draw exactly the pose the fit used.
      yaw = this.frameYaw ?? yaw; elevation = this.frameElevation;
    }
    this.camera.far = radius * 3 + 100;
    this.camera.zoom = building ? 1 : offset.zoomScale;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(
      target.x + Math.sin(yaw) * Math.cos(elevation) * radius,
      target.y + Math.sin(elevation) * radius,
      target.z + Math.cos(yaw) * Math.cos(elevation) * radius);
    this.camera.lookAt(target);
    if (this.sunLight) {
      this.sunLight.target.position.copy(this.cameraTarget);
      this.sunLight.position.copy(this.cameraTarget).add(new THREE.Vector3(-8, 18, 8));
    }
    // An orthographic view is determined by its direction, even when the user pans past a wall.
    this.backWall.visible = Math.cos(yaw) >= -.03;
    if (this.ownerSign) this.ownerSign.visible = this.backWall.visible;
    this.leftWall.visible = Math.sin(yaw) >= -.03;
  }

  private readonly animate = (now = performance.now()): void => { this.renderFrame(now); };

  private renderFrame(now: number): void {
    this.animationId = 0;
    if (this.disposed || document.hidden || this.suspended) {
      this.lastFrameTime = null;
      this.requestHiddenFrame();
      return;
    }
    this.animationId = requestAnimationFrame(this.animate);
    if (this.powerSaving && this.lastFrameTime !== null && now - this.lastFrameTime < 1000 / 30 - .5) return;
    const rawDelta = this.lastFrameTime === null ? 1 / 60 : Math.min(.25, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    this.container.dataset.animationState = this.paused ? 'paused' : this.reducedMotion ? 'reduced' : 'running';
    this.drawSceneFrame(rawDelta, now);
  }

  private drawSceneFrame(rawDelta: number, now: number): void {
    this.updateAnimation(rawDelta);
    if (this.wallDecor) this.wallDecor.visible = this.backWall.visible;
    if (this.clockHands) {
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== this.clockMinute) {
        this.clockMinute = minute;
        const date = new Date();
        this.clockHands.minute.rotation.z = -date.getMinutes() / 60 * Math.PI * 2;
        this.clockHands.hour.rotation.z = -((date.getHours() % 12) + date.getMinutes() / 60) / 12 * Math.PI * 2;
      }
    }
    this.updateWindowLight();
    this.updateRouterLed();
    this.updateCamera(rawDelta, now);
    this.updateDetailLevels();
    this.updateDeskWork();
    if (this.buildingView) this.building?.update(rawDelta, this.paused, this.reducedMotion,
      (this.camera.top - this.camera.bottom) / (Math.max(1, this.container.clientHeight) * this.camera.zoom));
    const flightCount = this.buildingView ? this.building?.activeFlightCount ?? 0 : this.paperFlights.length;
    if (this.container.dataset.paperFlights !== String(flightCount)) {
      this.container.dataset.paperFlights = String(flightCount);
      this.renderer.domElement.setAttribute?.('aria-description', `현재 컴퓨터 사이를 이동 중인 종이비행기 ${flightCount}개`);
    }
    this.renderer.render(this.scene, this.camera);
    this.container.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.container.dataset.triangles = String(this.renderer.info.render.triangles);
    this.updateOverlays();
    this.container.dataset.sceneReady = 'true';
  }

  private updateOverlays(): void {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (this.buildingView) {
      for (const figure of this.figures) { figure.label.style.display = 'none'; figure.bubble.style.display = 'none'; }
      this.visibleBubbles.clear(); this.camera.updateMatrixWorld(true);
      this.building?.updateLabels(this.camera, width, height, this.frameArea); return;
    }
    const activeCount = this.visibleFigureCount();
    const pixelsPerUnit = height * this.camera.zoom / (this.camera.top - this.camera.bottom);
    const candidates: BubbleCandidate[] = [];
    this.camera.updateMatrixWorld(true);
    for (const figure of this.figures) {
      if (!figure.group.visible) { figure.label.style.display = 'none'; continue; }
      // Head world position includes walking, turning and the existing small work animation.
      const anchor = figure.head.getWorldPosition(new THREE.Vector3())
        .add(new THREE.Vector3(0, figure.deskWork?.group.visible ? 1.4 : .75, 0));
      const cameraPoint = anchor.clone().applyMatrix4(this.camera.matrixWorldInverse);
      const projected = anchor.clone().project(this.camera);
      const inView = cameraPoint.z < 0 && [projected.x, projected.y, projected.z].every(Number.isFinite)
        && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z >= -1 && projected.z <= 1;
      const x = (projected.x * .5 + .5) * width;
      const y = (-projected.y * .5 + .5) * height;
      const selected = this.focusId === figure.id;
      const nameVisible = inView && this.showAgentName(figure) && (activeCount <= 30 || figure.detail?.visible || selected);
      figure.label.style.display = nameVisible ? 'flex' : 'none';
      figure.label.style.opacity = inView ? '1' : '0';
      if (nameVisible) {
        figure.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        figure.label.style.borderColor = selected ? '#7e9eaf' : 'rgba(125,150,168,.27)';
      }
      if (!inView || !this.activityBubblesVisible || !figure.activity.text) continue;
      const compact = !selected && (pixelsPerUnit < 16 || activeCount > 16);
      const text = compact ? figure.activity.compactText : figure.activity.text;
      if (figure.bubbleContent.textContent !== text) figure.bubbleContent.textContent = text;
      figure.bubble.dataset.compact = String(compact);
      figure.bubble.dataset.selected = String(selected);
      const priority = selected ? 100 : ['approval', 'error'].includes(figure.status) ? 70
        : ['working', 'thinking', 'reviewing'].includes(figure.status) ? 50 : 10;
      candidates.push({ id: figure.id, x, y, priority, nameVisible: !!nameVisible,
        nameWidth: figure.nameWidth, width: compact ? figure.compactBubbleWidth : figure.bubbleWidth });
    }
    const placements = new Map(placeActivityBubbles(candidates, width, height, this.visibleBubbles).map(item => [item.id, item]));
    this.visibleBubbles.clear();
    for (const figure of this.figures) {
      const placement = placements.get(figure.id);
      if (!placement || !figure.group.visible) { figure.bubble.style.display = 'none'; continue; }
      this.visibleBubbles.add(figure.id);
      figure.bubble.style.width = `${placement.width}px`;
      figure.bubble.style.transform = `translate(${placement.left}px, ${placement.top}px)`;
      figure.bubble.style.setProperty('--bubble-tail-x', `${placement.tailX}px`);
      figure.bubble.style.zIndex = this.focusId === figure.id ? '4' : '3';
      figure.bubble.style.display = 'block';
    }
  }

  private noteManualInteraction(): void {
    // Roster growth changes the automatic framing radius, but must not change a chosen world's scale.
    this.manualProjectionBase = (this.camera.top - this.camera.bottom) * .5 * this.cameraZoom;
    // Interrupting an automatic transition keeps its current zoom as the automatic shot, not as a user zoom.
    if (this.cinematic) this.automaticZoom = this.cameraZoom;
    this.motion = holdCinematicMotion(this.motion ?? createCinematicMotionState(), performance.now());
    if (this.following || this.cinematic) this.targetGoal.copy(this.cameraTarget);
    this.following = false;
    this.cinematic = false;
    this.zoomGoal = this.cameraZoom;
    this.autoRotateAfter = performance.now() + 5000;
  }

  private orbit(dx: number, dy: number): void {
    this.noteManualInteraction();
    const angles = orbitAngles(this.yaw, this.elevation, dx, dy);
    this.yaw = angles.yaw;
    this.elevation = angles.elevation;
  }

  private pan(dx: number, dy: number): void {
    const unitsPerPixel = (this.camera.top - this.camera.bottom) / Math.max(1, this.container.clientHeight);
    // Project screen right/up onto the floor so panning never sends the camera below ground.
    this.targetGoal.x += (-dx * Math.cos(this.yaw) - dy * Math.sin(this.yaw) / Math.sin(this.elevation)) * unitsPerPixel;
    this.targetGoal.z += (dx * Math.sin(this.yaw) - dy * Math.cos(this.yaw) / Math.sin(this.elevation)) * unitsPerPixel;
    // Manual framing is independent of seat capacity, including the stacked building view.
    // Empty-desk cleanup must not shorten a drag; resetCamera provides an explicit way back.
  }

  private cancelPointers(): void {
    const canvas = this.renderer.domElement;
    for (const id of this.cameraPointers.cancel()) {
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    }
    canvas.style.cursor = 'grab';
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    this.renderer.domElement.focus({ preventScroll: true });
    this.cameraPointers.begin(event.pointerId, event.clientX, event.clientY, event.button !== 0 || event.shiftKey);
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    if (this.cameraPointers.active) {
      const gesture = this.cameraPointers.move(event.pointerId, event.clientX, event.clientY);
      if (!gesture) return;
      this.noteManualInteraction();
      if (gesture.orbitX || gesture.orbitY) this.orbit(gesture.orbitX, gesture.orbitY);
      if (gesture.panX || gesture.panY) this.pan(gesture.panX, gesture.panY);
      if (gesture.zoomRatio !== 1) {
        this.cameraZoom = clampZoom(this.cameraZoom * gesture.zoomRatio);
        this.resize();
      }
      this.renderer.domElement.style.cursor = 'grabbing';
      return;
    }
    const hovered = this.buildingView ? (this.aimRay(event), !!this.building?.pickFloor(this.raycaster)) : !!this.pick(event);
    this.renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    if (this.cameraPointers.end(event.pointerId)) {
      if (this.buildingView) { this.aimRay(event); this.clickBuilding(); }
      else {
        const figure = this.pick(event);
        if (figure) {
          this.onSelect(figure.id);
          if (figure.id === 'boss') this.reactToOwnerClick();
        }
      }
    }
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
    this.renderer.domElement.style.cursor = this.cameraPointers.active ? 'grabbing' : 'grab';
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    if (this.cameraPointers.has(event.pointerId)) this.cancelPointers();
  };
  private readonly onBlur = (): void => { this.cancelPointers(); };
  private readonly onContextMenu = (event: MouseEvent): void => { event.preventDefault(); };
  private readonly onVisibilityChange = (): void => { this.syncRenderLoop(); };

  private readonly onWheel = (event: WheelEvent): void => { this.handleWheel(event); };

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    this.noteManualInteraction();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.container.clientHeight : 1);
    this.cameraZoom = clampZoom(this.cameraZoom * Math.exp(-THREE.MathUtils.clamp(pixels, -500, 500) * (event.ctrlKey ? .008 : .0016)));
    this.resize();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => { this.handleKeyDown(event); };

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') this.orbit(40, 0);
    else if (event.key === 'ArrowRight') this.orbit(-40, 0);
    else if (event.key === 'ArrowUp') this.orbit(0, 25);
    else if (event.key === 'ArrowDown') this.orbit(0, -25);
    else if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') this.zoom(.2);
    else if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') this.zoom(-.2);
    else if (event.key === 'Home') this.resetCamera();
    else if (this.buildingView && floorKeyStep(event.key)) {
      // PageUp/PageDown move the focus by one storey and the camera follows it.
      const next = this.building?.stepFocus(floorKeyStep(event.key));
      if (next) this.glideToBuildingFloor(next);
    }
    else return;
    event.preventDefault();
  }

  private aimRay(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /**
   * Two-step building click (decision 34) along the aimed ray: a floor that is not the focus becomes the focus; on the focus
   * floor a drawn person opens that person's office and card, and open space opens the floor's office like its plate.
   */
  private clickBuilding(): void {
    const building = this.building;
    if (!building) return;
    const floor = building.pickFloor(this.raycaster);
    const focused = building.focusedFloor;
    if (focused && floor !== focused && !(floor && building.pickAgent(this.raycaster, floor))) {
      // Ceilings are see-through (decision 48): a focus-floor person seen through the storey above still answers the click,
      // unless a drawn person of that storey stands in front.
      const seen = building.pickAgent(this.raycaster, focused);
      if (seen) { this.onSelect(seen); return; }
    }
    if (!floor) return;
    if (floor !== building.focusedFloor) { building.focusFloor(floor); this.glideToBuildingFloor(floor); return; }
    const agent = building.pickAgent(this.raycaster, floor);
    if (agent) this.onSelect(agent); else this.onFloor?.(floor);
  }

  private pick(event: PointerEvent): AgentFigure | undefined {
    if (this.buildingView) return;
    this.aimRay(event);
    const hits = this.raycaster.intersectObjects(this.figures.filter(figure => figure.group.visible && figure.detail?.visible !== false).map(figure => figure.group), true);
    const hit = hits[0];
    if (!hit) {
      const farHit = this.farFigures ? this.raycaster.intersectObject(this.farFigures)[0] : undefined;
      const figure = farHit?.instanceId === undefined ? undefined : this.figures[farHit.instanceId];
      return figure?.group.visible ? figure : undefined;
    }
    return this.figures.find(figure => {
      let object: THREE.Object3D | null = hit.object;
      while (object) {
        if (object === figure.group) return true;
        object = object.parent;
      }
      return false;
    });
  }
}
