import * as THREE from 'three';

export type WorkKind = 'coding' | 'documents' | 'research' | 'testing' | 'reviewing' | 'planning' | 'design' | 'delivery' | 'shipping' | 'general';
export type WorkPropsOptions = { reducedMotion?: boolean; intensity?: number; waiting?: boolean; error?: boolean };

const PALETTE = { shell: '#eef5fa', wood: '#d4b08a', green: '#9dbdaa', purple: '#b8acd8', gold: '#eed58e', blue: '#8fbbd2', paper: '#fffdf5', ink: '#31495e' };
const TAU = Math.PI * 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const cycle = (time: number, duration: number, offset = 0) => ((time / duration + offset) % 1 + 1) % 1;

/** Desk-sized, decorative tools. No source text, task progress or inferred success is displayed. */
export class WorkProps {
  readonly group = new THREE.Group();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly warning = new THREE.Group();
  private readonly warningBars: THREE.Mesh[] = [];
  private readonly tick: (time: number, intensity: number) => void;
  private lastTime: number | null = null;
  private motionTime: number;
  private disposed = false;

  constructor(kind: WorkKind, seed = 0) {
    const safeSeed = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 0;
    this.motionTime = safeSeed % 997 / 997 * 7;
    this.group.name = `work-props-${kind}`;
    this.group.userData.workKind = kind;
    const accent = [PALETTE.blue, PALETTE.purple, PALETTE.green][safeSeed % 3];
    switch (kind) {
      case 'coding': this.tick = this.coding(accent); break;
      case 'documents': this.tick = this.documents(accent); break;
      case 'research': this.tick = this.research(accent); break;
      case 'testing': this.tick = this.testing(accent); break;
      case 'reviewing': this.tick = this.reviewing(accent); break;
      case 'planning': this.tick = this.planning(accent); break;
      case 'design': this.tick = this.design(accent); break;
      case 'delivery': this.tick = this.delivery(accent); break;
      case 'shipping': this.tick = this.shipping(accent); break;
      default: this.tick = this.general(accent);
    }
    this.warning.name = 'work-pause-indicator';
    this.warning.position.set(.66, .43, .10);
    for (const x of [-.035, .035]) {
      this.warningBars.push(this.box(this.warning, 'pause-bar', PALETTE.gold, [.035, .14, .035], [x, 0, 0]));
    }
    this.warning.visible = false;
    this.group.add(this.warning);
    this.tick(this.motionTime, 1);
  }

  /** Absolute scene seconds; paused intervals never accumulate a catch-up jump. */
  update(time: number, options: WorkPropsOptions = {}): void {
    if (this.disposed) return;
    const now = Number.isFinite(time) ? time : this.lastTime ?? 0;
    const intensity = Number.isFinite(options.intensity) ? clamp(options.intensity!) : 1;
    const paused = Boolean(options.waiting || options.error);
    const staticPose = options.reducedMotion || intensity === 0;
    if (this.lastTime !== null && !paused && !staticPose) this.motionTime += Math.max(0, now - this.lastTime);
    this.lastTime = now;
    this.tick(staticPose ? 1.8 : this.motionTime, staticPose ? 0 : intensity);
    this.warning.visible = paused;
    this.warning.name = options.error ? 'work-error-indicator' : 'work-pause-indicator';
    this.warningBars.forEach((bar, index) => {
      bar.position.x = options.error ? 0 : index ? .035 : -.035;
      bar.rotation.z = options.error ? (index ? -1 : 1) * Math.PI / 4 : 0;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }

  private geometry(shape: string): THREE.BufferGeometry {
    let geometry = this.geometries.get(shape);
    if (!geometry) {
      if (shape === 'sphere') geometry = new THREE.SphereGeometry(1, 10, 7);
      else if (shape === 'cylinder') geometry = new THREE.CylinderGeometry(1, 1, 1, 10);
      else if (shape === 'ring') geometry = new THREE.TorusGeometry(1, .13, 5, 18);
      else geometry = new THREE.BoxGeometry(1, 1, 1);
      this.geometries.set(shape, geometry);
    }
    return geometry;
  }

  private mesh(parent: THREE.Object3D, name: string, color: string, shape: string,
    scale: [number, number, number], position: [number, number, number]): THREE.Mesh {
    let material = this.materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: .64, metalness: .06, flatShading: true });
      this.materials.set(color, material);
    }
    const mesh = new THREE.Mesh(this.geometry(shape), material);
    mesh.name = name; mesh.scale.set(...scale); mesh.position.set(...position);
    parent.add(mesh);
    return mesh;
  }

  private box(parent: THREE.Object3D, name: string, color: string,
    scale: [number, number, number], position: [number, number, number]): THREE.Mesh {
    return this.mesh(parent, name, color, 'box', scale, position);
  }

  private subgroup(name: string, position: [number, number, number], parent: THREE.Object3D = this.group): THREE.Group {
    const group = new THREE.Group(); group.name = name; group.position.set(...position); parent.add(group); return group;
  }

  private sheet(parent: THREE.Object3D, name: string, width = .29, height = .35): THREE.Group {
    const page = this.subgroup(name, [0, 0, 0], parent);
    this.box(page, 'decorative-paper', PALETTE.paper, [width, height, .019], [0, 0, 0]);
    for (let i = 0; i < 4; i++) {
      this.box(page, `decorative-line-${i}`, i === 0 ? PALETTE.blue : PALETTE.ink,
        [width * (i === 3 ? .45 : .72), i === 0 ? .025 : .011, .008], [-width * (i === 3 ? .135 : 0), height * .28 - i * height * .16, .015]);
    }
    return page;
  }

  private coding(accent: string): (time: number, intensity: number) => void {
    // The tiny floating workbench sits above the screen edge: the seated employee's head
    // must not hide the machine or the grippers in the existing rear camera view.
    const assemblyX = .25, assemblyZ = .30;
    this.box(this.group, 'assembly-pedestal', PALETTE.ink, [.58, .055, .39], [assemblyX, .38, assemblyZ]);
    this.box(this.group, 'assembly-circuit', accent, [.48, .025, .31], [assemblyX, .42, assemblyZ]);
    const machine = this.subgroup('code-block-machine', [assemblyX, .51, assemblyZ]);
    const blocks = Array.from({ length: 4 }, (_, i) => this.box(machine, `code-block-${i}`,
      [accent, PALETTE.gold, PALETTE.green, PALETTE.paper][i], [.14, .12, .15], [(i % 2 - .5) * .18, Math.floor(i / 2) * .14, 0]));
    const gear = this.mesh(machine, 'assembled-gear', PALETTE.wood, 'ring', [.075, .075, .075], [0, .07, .14]);
    const arms = [-1, 1].map(side => {
      this.box(this.group, 'monitor-arm-port', PALETTE.ink, [.14, .14, .06], [side * .48, .03, .085]);
      const arm = this.subgroup(side < 0 ? 'left-robot-arm' : 'right-robot-arm', [0, 0, 0]);
      const shoulder = this.mesh(arm, 'robot-shoulder', accent, 'sphere', [.07, .07, .07], [side * .48, .03, .14]);
      const elbow = this.mesh(arm, 'robot-elbow', PALETTE.wood, 'sphere', [.061, .061, .061], [0, 0, 0]);
      const wrist = this.mesh(arm, 'robot-wrist', accent, 'sphere', [.05, .05, .05], [0, 0, 0]);
      const upper = this.mesh(arm, 'robot-upper-link', PALETTE.shell, 'cylinder', [.04, 1, .04], [0, 0, 0]);
      const fore = this.mesh(arm, 'robot-fore-link', PALETTE.shell, 'cylinder', [.032, 1, .032], [0, 0, 0]);
      const claws = Array.from({ length: 2 }, () => this.box(arm, 'robot-gripper', PALETTE.ink, [.025, .075, .03], [0, 0, 0]));
      return { side, shoulder, elbow, wrist, upper, fore, claws };
    });
    for (let i = 0; i < 5; i++) this.box(this.group, 'decorative-code-token', i % 2 ? accent : PALETTE.gold,
      [.055 + i % 3 * .027, .018, .012], [-.13 + i % 2 * .10, .30 - i * .045, .065]);
    const axis = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3();
    const link = (mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) => {
      direction.subVectors(to, from); mesh.position.copy(from).addScaledVector(direction, .5);
      mesh.scale.y = direction.length(); mesh.quaternion.setFromUnitVectors(axis, direction.normalize());
    };
    return (time, intensity) => {
      arms.forEach(({ side, shoulder, elbow, wrist, upper, fore, claws }, i) => {
        const wave = Math.sin(time * 1.5 + i * Math.PI) * intensity;
        elbow.position.set(.12 + side * (.43 + wave * .035), .42 + wave * .035, .23);
        wrist.position.set(assemblyX + side * (.09 + wave * .02), .725 + wave * .02, assemblyZ);
        link(upper, shoulder.position, elbow.position); link(fore, elbow.position, wrist.position);
        claws.forEach((claw, j) => claw.position.set(wrist.position.x + (j ? 1 : -1) * (.05 + (1 + wave) * .01), wrist.position.y - .055, wrist.position.z));
      });
      blocks.forEach((block, i) => {
        const side = i % 2 ? 1 : -1;
        const wave = Math.sin(time * 1.5 + i % 2 * Math.PI) * intensity;
        block.position.x = side * .09 + (i >= 2 ? side * .02 * wave : 0);
        block.position.y = i >= 2 ? .16 + wave * .02 : 0;
        block.rotation.y = i >= 2 ? Math.sin(time * .8 + i) * .055 * intensity : 0;
      });
      gear.rotation.z = time * .35 * intensity;
    };
  }

  private documents(accent: string): (time: number, intensity: number) => void {
    this.box(this.group, 'document-output-slot', PALETTE.ink, [.43, .045, .07], [-.24, -.17, .095]);
    const folder = this.subgroup('document-filing-folder', [.40, -.15, .43]);
    this.box(folder, 'folder-back', accent, [.36, .28, .025], [0, .04, 0]);
    this.box(folder, 'folder-front', PALETTE.wood, [.36, .18, .025], [0, -.015, .15]);
    this.box(folder, 'folder-base', PALETTE.wood, [.36, .025, .17], [0, -.10, .075]);
    this.box(folder, 'folder-tab', accent, [.12, .055, .025], [-.10, .205, 0]);
    const pages = [0, 1, 2].map(i => this.sheet(this.group, `document-page-${i}`, .28, .34));
    return (time, intensity) => {
      pages.forEach((page, index) => {
        const p = cycle(time, 7.2, index / 3);
        const print = ease(p / .32), fly = ease((p - .32) / .34), file = ease((p - .76) / .24);
        page.position.set(-.24 + fly * .64, .035 + Math.sin(fly * Math.PI) * .22 - file * .21, .077 + fly * .42);
        page.rotation.set(-fly * .08, Math.sin(fly * Math.PI) * .22 * intensity, Math.sin(fly * Math.PI) * -.15 * intensity);
        page.scale.setScalar(1 - file * .87);
        page.visible = p < .97;
        page.children.slice(1).forEach((line, lineIndex) => {
          const amount = ease((print * 5 - lineIndex) / .9);
          const width = .28 * (lineIndex === 3 ? .45 : .72);
          line.scale.x = Math.max(.0001, width * amount);
          line.position.x = -.28 * .36 + width * amount / 2;
          line.visible = amount > .01;
        });
      });
    };
  }

  private research(accent: string): (time: number, intensity: number) => void {
    const drone = this.subgroup('research-drone', [0, .36, .35]);
    this.mesh(drone, 'drone-body', accent, 'sphere', [.13, .075, .09], [0, 0, 0]);
    this.box(drone, 'drone-visor', PALETTE.ink, [.12, .04, .018], [0, .005, .086]);
    const rotors = [-1, 1].map(side => {
      this.box(drone, 'rotor-strut', PALETTE.wood, [.15, .028, .025], [side * .13, .015, 0]);
      return this.box(drone, 'drone-propeller', PALETTE.paper, [.20, .018, .065], [side * .225, .056, 0]);
    });
    const carried = this.sheet(drone, 'retrieved-document', .15, .18); carried.position.set(0, -.17, .015);
    const cards = [0, 1, 2].map(i => {
      const card = this.sheet(this.group, `research-source-${i}`, .18, .23);
      card.position.set(-.39 + i * .38, -.14 + i % 2 * .06, .22 + i * .07); card.rotation.z = (i - 1) * -.12; return card;
    });
    return (time, intensity) => {
      drone.position.set(Math.sin(time * .58) * .29 * intensity, .40 + Math.sin(time * 1.7) * .045 * intensity, .34);
      drone.rotation.z = Math.cos(time * .58) * -.06 * intensity;
      rotors.forEach((rotor, i) => rotor.rotation.y = time * (i ? -9 : 9) * intensity);
      cards.forEach((card, i) => card.position.y = -.14 + i % 2 * .06 + Math.sin(time * 1.3 + i) * .025 * intensity);
      carried.rotation.z = Math.sin(time * 1.2) * .07 * intensity;
    };
  }

  private testing(accent: string): (time: number, intensity: number) => void {
    this.box(this.group, 'test-bench', PALETTE.ink, [.82, .055, .42], [0, -.27, .40]);
    for (const x of [-.33, .33]) this.box(this.group, 'test-gantry-column', accent, [.065, .48, .06], [x, -.005, .27]);
    this.box(this.group, 'test-gantry-beam', accent, [.73, .07, .08], [0, .27, .27]);
    const scanner = this.subgroup('test-probe', [0, .17, .38]);
    this.box(scanner, 'probe-head', PALETTE.wood, [.15, .10, .13], [0, 0, 0]);
    this.box(scanner, 'probe-light', PALETTE.gold, [.11, .025, .09], [0, -.06, 0]);
    const sample = this.subgroup('test-specimen', [0, -.14, .43]);
    this.box(sample, 'test-specimen-base', PALETTE.shell, [.24, .12, .18], [0, 0, 0]);
    this.box(sample, 'test-specimen-chip', accent, [.13, .045, .09], [0, .09, 0]);
    const meters = [0, 1, 2, 3].map(i => this.box(this.group, 'test-measurement-bar', PALETTE.gold,
      [.034, .035, .019], [.43, -.19 + i * .062, .42]));
    return (time, intensity) => {
      scanner.position.x = Math.sin(time * 1.1) * .24 * intensity;
      scanner.position.y = .15 + Math.cos(time * 2.2) * .025 * intensity;
      sample.rotation.y = Math.sin(time * .65) * .12 * intensity;
      meters.forEach((bar, i) => bar.scale.x = .055 + (1 + Math.sin(time * 1.8 + i)) * .025 * intensity);
    };
  }

  private reviewing(accent: string): (time: number, intensity: number) => void {
    const page = this.sheet(this.group, 'review-document', .38, .47); page.position.set(-.13, .025, .23);
    this.box(this.group, 'review-document-clip', PALETTE.wood, [.15, .045, .035], [-.13, .27, .24]);
    const lens = this.subgroup('review-magnifier', [.15, .09, .39]);
    this.mesh(lens, 'magnifier-rim', accent, 'ring', [.135, .135, .135], [0, 0, 0]);
    const handle = this.box(lens, 'magnifier-handle', PALETTE.wood, [.042, .20, .042], [.13, -.15, 0]); handle.rotation.z = .6;
    this.box(lens, 'magnifier-glint', PALETTE.paper, [.025, .07, .018], [-.045, .04, .015]).rotation.z = -.6;
    const notes = [0, 1].map(i => this.box(this.group, 'review-annotation', i ? PALETTE.gold : accent,
      [.11, .09, .021], [.31, -.08 - i * .12, .15]));
    return (time, intensity) => {
      lens.position.set(.05 + Math.sin(time * .75) * .16 * intensity, .08 + Math.cos(time * .9) * .12 * intensity, .39);
      lens.rotation.z = Math.sin(time * .5) * .10 * intensity;
      notes.forEach((note, i) => note.rotation.z = Math.sin(time * .7 + i) * .05 * intensity);
    };
  }

  private planning(accent: string): (time: number, intensity: number) => void {
    this.box(this.group, 'planning-board-frame', PALETTE.wood, [.80, .60, .055], [0, .07, .12]);
    this.box(this.group, 'planning-board-face', PALETTE.paper, [.73, .53, .014], [0, .07, .158]);
    for (const x of [-.12, .12]) this.box(this.group, 'planning-column-divider', PALETTE.shell, [.008, .39, .009], [x, .045, .174]);
    for (let i = 0; i < 3; i++) this.box(this.group, 'planning-column-header', PALETTE.ink, [.12, .026, .008], [(i - 1) * .245, .27, .174]);
    const cards = [0, 1, 2, 3, 4].map(i => {
      const card = this.subgroup(`planning-card-${i}`, [0, 0, 0]);
      this.box(card, 'planning-card-paper', [accent, PALETTE.gold, PALETTE.green][i % 3], [.17, .12, .024], [0, 0, 0]);
      this.box(card, 'planning-card-line', PALETTE.paper, [.10, .017, .01], [0, .015, .018]); return card;
    });
    return (time, intensity) => cards.forEach((card, i) => {
      const p = cycle(time, 9, i * .17), shift = ease((p - .28) / .25) - ease((p - .73) / .25);
      card.position.set((i % 3 - 1) * .245 + (i === 0 ? shift * .245 * intensity : 0), .13 - Math.floor(i / 3) * .18, .19 + (i === 0 ? Math.sin(shift * Math.PI) * .12 * intensity : 0));
      card.rotation.z = Math.sin(time * .7 + i) * .02 * intensity;
    });
  }

  private design(accent: string): (time: number, intensity: number) => void {
    const canvas = this.subgroup('design-easel', [-.10, .07, .23]);
    for (const x of [-.21, .21]) this.box(canvas, 'easel-leg', PALETTE.wood, [.04, .50, .055], [x, -.09, -.04]);
    this.box(canvas, 'canvas-frame', PALETTE.wood, [.53, .42, .035], [0, .08, 0]);
    this.box(canvas, 'canvas-paper', PALETTE.paper, [.46, .35, .014], [0, .08, .025]);
    const marks = [0, 1, 2].map(i => this.box(canvas, 'decorative-paint-stroke', [accent, PALETTE.gold, PALETTE.green][i],
      [.12 + i * .035, .055, .014], [(i - 1) * .05, .18 - i * .09, .043]));
    const brush = this.subgroup('design-brush', [.19, .20, .41]);
    this.box(brush, 'brush-handle', PALETTE.wood, [.031, .25, .031], [0, 0, 0]);
    this.box(brush, 'brush-ferrule', PALETTE.shell, [.047, .065, .045], [0, -.145, 0]);
    this.box(brush, 'brush-tip', accent, [.053, .063, .043], [0, -.20, 0]);
    this.mesh(this.group, 'paint-palette', PALETTE.wood, 'sphere', [.16, .075, .028], [.44, -.13, .31]);
    for (let i = 0; i < 3; i++) this.mesh(this.group, 'palette-paint', [accent, PALETTE.gold, PALETTE.green][i],
      'sphere', [.035, .028, .018], [.35 + i * .08, -.13, .344]);
    return (time, intensity) => {
      brush.position.set(.06 + Math.sin(time * 1.1) * .18 * intensity, .23 + Math.sin(time * .8) * .07 * intensity, .41);
      brush.rotation.z = -.45 + Math.cos(time * 1.1) * .16 * intensity;
      marks.forEach((mark, i) => mark.scale.x = (.12 + i * .035) * (.8 + .2 * (1 + Math.sin(time * .8 - i)) * intensity));
    };
  }

  private delivery(accent: string): (time: number, intensity: number) => void {
    this.box(this.group, 'dispatch-outbox', PALETTE.wood, [.54, .055, .32], [0, -.24, .35]);
    this.box(this.group, 'dispatch-outbox-back', accent, [.54, .17, .035], [0, -.17, .20]);
    const envelope = this.subgroup('dispatch-envelope', [0, .015, .39]);
    this.box(envelope, 'envelope-paper', PALETTE.paper, [.36, .23, .025], [0, 0, 0]);
    for (const side of [-1, 1]) this.box(envelope, 'envelope-fold', accent, [.20, .012, .008], [side * .075, .015, .02]).rotation.z = side * .55;
    const plane = this.subgroup('dispatch-folded-plane', [0, .22, .38]);
    const wingGeometry = new THREE.BufferGeometry();
    wingGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, .022, .15, -.17, 0, -.10, 0, .022, -.05, 0, .022, .15, 0, .022, -.05, .17, 0, -.10], 3));
    wingGeometry.computeVertexNormals(); this.geometries.set('plane-wings', wingGeometry);
    const wingMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.paper, side: THREE.DoubleSide, roughness: .7 });
    this.materials.set('plane-wings', wingMaterial);
    const wings = new THREE.Mesh(wingGeometry, wingMaterial); wings.name = 'dispatch-plane-wings'; plane.add(wings);
    this.box(plane, 'dispatch-plane-crease', accent, [.016, .023, .19], [0, .02, .015]);
    return (time, intensity) => {
      plane.position.set(Math.sin(time * .8) * .19 * intensity, .20 + Math.sin(time * 1.5) * .05 * intensity, .40 + Math.cos(time * .8) * .035 * intensity);
      plane.rotation.set(.23, Math.sin(time * .8) * .22 * intensity, Math.cos(time * .8) * -.10 * intensity);
      envelope.position.y = .005 + Math.sin(time * 1.2) * .025 * intensity;
    };
  }

  private shipping(accent: string): (time: number, intensity: number) => void {
    this.box(this.group, 'shipping-conveyor', PALETTE.ink, [.86, .05, .35], [0, -.25, .41]);
    const rollers = Array.from({ length: 6 }, (_, i) => {
      const roller = this.mesh(this.group, 'shipping-roller', PALETTE.shell, 'cylinder', [.038, .32, .038], [-.35 + i * .14, -.21, .41]);
      roller.rotation.x = Math.PI / 2; return roller;
    });
    const parcel = this.subgroup('shipping-parcel', [0, -.03, .41]);
    this.box(parcel, 'parcel-box', PALETTE.wood, [.27, .25, .23], [0, 0, 0]);
    this.box(parcel, 'parcel-ribbon-front', accent, [.052, .25, .013], [0, 0, .124]);
    this.box(parcel, 'parcel-label', PALETTE.paper, [.07, .055, .012], [.075, .04, .127]);
    this.box(parcel, 'parcel-ribbon-top', accent, [.052, .015, .23], [0, .13, 0]);
    const lid = this.subgroup('parcel-lid', [0, .13, 0], parcel);
    this.box(lid, 'parcel-lid-panel', PALETTE.wood, [.28, .025, .235], [0, 0, 0]);
    const stamp = this.subgroup('packing-stamp', [.25, .29, .42]);
    this.box(stamp, 'stamp-pad', accent, [.16, .05, .12], [0, 0, 0]);
    this.box(stamp, 'stamp-grip', PALETTE.wood, [.05, .13, .05], [0, .07, 0]);
    return (time, intensity) => {
      const wave = Math.sin(time * .8);
      parcel.position.x = wave * .21 * intensity;
      lid.position.y = .13 + Math.max(0, Math.sin(time * .8 + 1.8)) * .10 * intensity;
      lid.rotation.z = Math.max(0, Math.sin(time * .8 + 1.8)) * -.13 * intensity;
      stamp.position.y = .30 - Math.max(0, Math.sin(time * 1.6)) * .085 * intensity;
      rollers.forEach(roller => roller.rotation.y = time * .5 * intensity);
    };
  }

  private general(accent: string): (time: number, intensity: number) => void {
    this.box(this.group, 'general-workstation-base', PALETTE.wood, [.53, .055, .33], [0, -.24, .35]);
    const ring = this.mesh(this.group, 'general-work-ring', accent, 'ring', [.18, .18, .18], [0, .08, .30]);
    const cubes = [0, 1, 2].map(i => this.box(this.group, 'general-work-block', [accent, PALETTE.gold, PALETTE.green][i], [.085, .085, .085], [0, 0, 0]));
    return (time, intensity) => {
      ring.rotation.z = time * .28 * intensity;
      cubes.forEach((cube, i) => {
        const angle = i / 3 * TAU + time * .45 * intensity;
        cube.position.set(Math.cos(angle) * .18, .08 + Math.sin(angle) * .18, .33);
        cube.rotation.z = angle * .4;
      });
    };
  }
}
