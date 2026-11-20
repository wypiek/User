// User — the character. Built from the 2006 figure FBX, re-rigged with simple
// joint pivots and animated in a deliberately choppy, stop-motion way.
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const BLUE = 0x0000ff;
const BLACK = 0x050507;
const ANIM_FPS = 15; // every pose updates at 15 fps; the choppiness comes from holds, drops and jitter
const UNIT = 0.01; // FBX units -> studs (the figure is ~5 studs tall, like in 2006)

// ---------------------------------------------------------------- textures
function makeFaceTexture(): THREE.Texture {
  // Same layout as one 128px slot of rblx_faces.png, at 2x resolution.
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0000ff';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#000';
  g.strokeStyle = '#000';
  g.lineCap = 'round';
  g.translate(128, 120);
  g.scale(1.55, 1.55);
  g.translate(-128, -128);
  // eyes: two thin, uneven, slanted slits (like the reference picture)
  const eye = (x: number, y: number, rx: number, ry: number, rot: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.beginPath();
    g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  eye(105, 90, 7, 19, 0.32);
  eye(150, 88, 8, 21, -0.06);
  // small dark bags under the eyes
  g.globalAlpha = 0.35;
  g.lineWidth = 3;
  g.beginPath(); g.arc(104, 112, 9, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  g.beginPath(); g.arc(151, 112, 9, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  g.globalAlpha = 1;
  // mouth: an open, trembling frown
  g.lineWidth = 11;
  g.beginPath();
  g.moveTo(102, 172);
  g.bezierCurveTo(104, 132, 152, 128, 156, 168);
  g.stroke();
  g.lineWidth = 9;
  g.beginPath(); g.moveTo(102, 172); g.lineTo(98, 176); g.stroke();
  g.beginPath(); g.moveTo(156, 168); g.lineTo(161, 172); g.stroke();
  // inner gap of the open mouth
  g.lineWidth = 6;
  g.beginPath(); g.moveTo(116, 166); g.bezierCurveTo(120, 148, 140, 148, 143, 164); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

class GearShirt {
  // Three blue gears on a black shirt, redrawn whenever they turn.
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private angle = 0;

  constructor() {
    this.canvas.width = this.canvas.height = 256;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.draw();
  }

  private gear(cx: number, cy: number, r: number, teeth: number, rot: number) {
    const g = this.g;
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    g.beginPath();
    const steps = teeth * 4;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rr = i % 4 === 1 || i % 4 === 2 ? r : r * 0.8;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.fillStyle = '#0000ff';
    g.fill();
    g.beginPath();
    g.ellipse(0, 0, r * 0.47, r * 0.55, 0, 0, Math.PI * 2);
    g.fillStyle = '#000';
    g.fill();
    g.restore();
  }

  draw() {
    const g = this.g;
    const a = this.angle;
    g.clearRect(0, 0, 256, 256);
    this.gear(52, 62, 36, 18, a);
    this.gear(126, 108, 41, 20, -a * 0.88 + 0.1);
    this.gear(70, 160, 38, 19, -a * 0.95 + 0.2);
    this.texture.needsUpdate = true;
  }

  turn(by: number) {
    this.angle += by;
    this.draw();
  }
}

// ---------------------------------------------------------------- rig
function bakeParts(fbx: THREE.Group): Record<string, THREE.BufferGeometry> {
  fbx.updateMatrixWorld(true);
  const flip = new THREE.Matrix4().makeRotationY(Math.PI); // make the figure face +Z
  const parts: Record<string, THREE.BufferGeometry> = {};
  fbx.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    let geo = (o.geometry as THREE.BufferGeometry).clone();
    if (geo.index) geo = geo.toNonIndexed();
    for (const k of ['skinIndex', 'skinWeight', 'color']) geo.deleteAttribute(k);
    geo.applyMatrix4(o.matrixWorld).applyMatrix4(flip);
    geo.computeBoundingBox();
    const id = (o.name.match(/(\d+)$/) || [])[1];
    if (id) parts[id] = geo;
  });
  return parts;
}

function centered(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const c = geo.boundingBox!.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);
  geo.computeBoundingBox();
  return geo;
}

function splitByX(geo: THREE.BufferGeometry): { neg: THREE.BufferGeometry; pos: THREE.BufferGeometry } {
  // The FBX stores both arms in one mesh; cut it in two by which side each triangle is on.
  const pos = geo.attributes.position;
  const sides: { neg: number[]; pos: number[] } = { neg: [], pos: [] };
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    sides[cx < 0 ? 'neg' : 'pos'].push(t);
  }
  const make = (tris: number[]) => {
    const out = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) {
      const src = geo.attributes[name] as THREE.BufferAttribute;
      const arr = new Float32Array(tris.length * 3 * src.itemSize);
      let w = 0;
      for (const t of tris) for (let v = 0; v < 3; v++) for (let k = 0; k < src.itemSize; k++) arr[w++] = src.array[(t + v) * src.itemSize + k];
      out.setAttribute(name, new THREE.BufferAttribute(arr, src.itemSize));
    }
    return out;
  };
  return { neg: make(sides.neg), pos: make(sides.pos) };
}

export async function loadCharacter(url: string): Promise<Character> {
  const fbx = await new FBXLoader().loadAsync(url);
  const p = bakeParts(fbx);

  const matBlue = new THREE.MeshLambertMaterial({ color: BLUE });
  const matBlack = new THREE.MeshLambertMaterial({ color: BLACK });
  const matFace = new THREE.MeshLambertMaterial({ map: makeFaceTexture(), polygonOffset: true, polygonOffsetFactor: -1 });
  const shirt = new GearShirt();
  const matShirt = new THREE.MeshLambertMaterial({ map: shirt.texture, transparent: true, alphaTest: 0.1, polygonOffset: true, polygonOffsetFactor: -2 });
  // thin blue rim around every part (inverted hull), like the outline in the reference picture
  const matRim = new THREE.MeshBasicMaterial({ color: 0x1a2cff, side: THREE.BackSide });

  // head: remap the face UVs from the atlas slot onto our own face texture
  const head = p['009'];
  const uv = head.attributes.uv;
  const faceGroup = head.groups.find((g) => g.materialIndex === 1);
  if (faceGroup) {
    for (let i = faceGroup.start; i < faceGroup.start + faceGroup.count; i++) uv.setY(i, (uv.getY(i) - 0.75) / 0.25);
    uv.needsUpdate = true;
  }
  const headH = head.boundingBox!.max.y - head.boundingBox!.min.y;
  centered(head);

  const arms = splitByX(p['011']);
  const parts = {
    torso: centered(p['012']),
    decal: centered(p['013']),
    legA: centered(p['003']),
    legB: centered(p['008']),
    armA: centered(arms.neg),
    armB: centered(arms.pos),
  };

  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], rim = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    if (rim) {
      geo.computeBoundingBox();
      const size = geo.boundingBox!.getSize(new THREE.Vector3());
      const r = new THREE.Mesh(geo, matRim);
      r.scale.set(1 + 8 / size.x, 1 + 8 / size.y, 1 + 8 / size.z); // ~4 units of rim each side
      m.add(r);
    }
    return m;
  };
  const at = <T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T => {
    obj.position.set(x, y, z);
    return obj;
  };
  const pivot = (parent: THREE.Object3D, x: number, y: number, z: number) => {
    const g = at(new THREE.Group(), x, y, z);
    parent.add(g);
    return g;
  };

  // Hierarchy (FBX units; `body` is scaled to studs):
  // root -> body -> legL, legR, torsoPivot -> torso, decal, neck -> head, armL, armR
  const root = new THREE.Group();
  root.name = 'User';
  const body = new THREE.Group(); // whole-body offsets (summon rise)
  body.scale.setScalar(UNIT);
  root.add(body);

  const torsoPivot = pivot(body, 0, 200, 0);
  torsoPivot.add(at(mesh(parts.torso, matBlack), 0, 100, 0));
  torsoPivot.add(at(mesh(parts.decal, matShirt, false), 0, 100, 51.5));
  const neck = pivot(torsoPivot, 0, 200, 0);
  neck.add(at(mesh(head, [matBlue, matFace]), 0, headH / 2 - 2, 0));
  // character's left is +X (he faces +Z, toward the camera)
  const armL = pivot(torsoPivot, 150, 180, 0);
  armL.add(at(mesh(parts.armB, matBlue), 0, -80, 0));
  const armR = pivot(torsoPivot, -150, 180, 0);
  armR.add(at(mesh(parts.armA, matBlue), 0, -80, 0));
  const legL = pivot(body, 50, 200, 0);
  legL.add(at(mesh(parts.legB, matBlack), 0, -100, 0));
  const legR = pivot(body, -50, 200, 0);
  legR.add(at(mesh(parts.legA, matBlack), 0, -100, 0));

  return new Character(root, { body, torsoPivot, neck, armL, armR, legL, legR }, shirt);
}

// ---------------------------------------------------------------- animation
const POSE_KEYS = ['bodyY', 'bodyTurn', 'torsoX', 'torsoZ', 'torsoY', 'headX', 'headY', 'headZ',
  'armLX', 'armLZ', 'armLY', 'armRX', 'armRZ', 'armRY', 'legLX', 'legRX'] as const;
type Pose = Record<(typeof POSE_KEYS)[number], number>;
const ZERO = Object.fromEntries(POSE_KEYS.map((k) => [k, 0])) as Pose;

export type AnimState = 'summon' | 'idle' | 'thinking' | 'responding' | 'waiting' | 'doing';
interface AnimCtx { syllable: number; listening: boolean }
interface StateDef { fps: number; duration?: number; pose(t: number, n: number, ctx: AnimCtx): Pose }

// deterministic per-step noise so a held frame stays exactly held
function hash(n: number): number { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
const sq = (x: number) => (Math.sin(x) >= 0 ? 1 : -1);

const STATES: Record<AnimState, StateDef> = {
  // ~3.4 s: flickers, crawls up out of the floor, then reaches out at you
  summon: {
    fps: ANIM_FPS, duration: 3.4,
    pose(t, n) {
      const p = { ...ZERO };
      const rise = Math.min(1, Math.max(0, (t - 0.35) / 1.5));
      p.bodyY = (rise - 1) * 540;
      p.armLX = p.armRX = -2.9 + rise * 0.6;
      p.armLZ = 0.25; p.armRZ = -0.25;
      p.headX = -0.35 + rise * 0.2;
      p.headY = (hash(n) - 0.5) * 1.2 * (1 - rise);
      p.headZ = (hash(n + 9) - 0.5) * 0.8;
      if (t > 1.9) { // the pose from the photo: arms stretched out toward the viewer
        p.armLX = -1.45; p.armRX = -1.35; p.armLZ = 0.32; p.armRZ = -0.38; p.armLY = -0.2; p.armRY = 0.25;
        p.headX = 0.12; p.headZ = 0.18 + (hash(n) - 0.5) * 0.1; p.torsoZ = -0.05;
      }
      return p;
    },
  },
  // breathing, head hung, the occasional twitch
  idle: {
    fps: ANIM_FPS,
    pose(t, n) {
      const p = { ...ZERO };
      p.torsoX = 0.03 + Math.sin(t * 1.3) * 0.025;
      p.headX = 0.22 + Math.sin(t * 0.7) * 0.05;
      p.headZ = 0.1 + Math.sin(t * 0.45) * 0.08;
      p.armLX = Math.sin(t * 1.3) * 0.05; p.armRX = Math.sin(t * 1.3 + 0.4) * 0.05;
      p.armLZ = 0.06; p.armRZ = -0.06;
      if (hash(Math.floor(n / 3)) > 0.93) { p.headY = (hash(n) - 0.5) * 0.9; p.headZ += 0.25; } // twitch
      if (hash(Math.floor(n / 5) + 77) > 0.96) p.armRX = -0.5; // a little reach
      return p;
    },
  },
  // hand to head, staring at the floor, swaying
  thinking: {
    fps: ANIM_FPS,
    pose(t) {
      const p = { ...ZERO };
      p.armRX = -2.55; p.armRZ = 0.55; p.armRY = 0.3; // right hand up to the side of the head
      p.armLX = -0.75; p.armLZ = -0.35; // left arm across the chest
      p.headX = 0.3; p.headZ = -0.22 + sq(t * 2.6) * 0.07;
      p.headY = sq(t * 1.3) * 0.18;
      p.torsoZ = Math.sin(t * 1.7) * 0.06; p.torsoX = 0.08;
      p.legLX = Math.sin(t * 1.7) * 0.06; p.legRX = -p.legLX;
      return p;
    },
  },
  // jerky gestures + a head bob on every syllable (sound)
  responding: {
    fps: ANIM_FPS,
    pose(t, _n, ctx) {
      const p = { ...ZERO };
      const syl = ctx.syllable; // bumps each time a voice sound starts
      p.armLX = -0.35 - Math.abs(Math.sin(t * 3.1)) * 0.6; p.armLZ = 0.15 + hash(syl * 3) * 0.2;
      p.armRX = -0.25 - Math.abs(Math.sin(t * 2.3 + 1)) * 0.7; p.armRZ = -0.15 - hash(syl * 5) * 0.25;
      p.headX = 0.02 + (syl % 2 ? 0.12 : -0.05);
      p.headZ = (hash(syl) - 0.5) * 0.35;
      p.headY = (hash(syl + 11) - 0.5) * 0.3;
      p.torsoX = 0.05; p.torsoZ = (hash(syl + 3) - 0.5) * 0.06;
      return p;
    },
  },
  // looking straight at you, head tilted, swaying in place
  waiting: {
    fps: ANIM_FPS,
    pose(t, n, ctx) {
      const p = { ...ZERO };
      p.headX = -0.04; p.headZ = 0.24 + sq(t * 0.9) * 0.04;
      p.armLX = -0.22; p.armRX = -0.18; p.armLZ = 0.1; p.armRZ = -0.1;
      p.torsoZ = sq(t * 1.5) * 0.035; p.torsoY = sq(t * 0.6) * 0.04;
      if (ctx.listening) { // leaning in, one hand up near the ear
        p.torsoX = 0.12; p.headZ = 0.38; p.armLX = -2.4; p.armLZ = -0.5; p.armLY = -0.3;
      }
      if (hash(Math.floor(n / 4) + 5) > 0.95) p.headY = (hash(n) - 0.5) * 0.7;
      return p;
    },
  },
  // working invisible levers: both arms out, pumping, head snapping around
  doing: {
    fps: ANIM_FPS,
    pose(t, n) {
      const p = { ...ZERO };
      p.armLX = -1.45 + sq(t * 13) * 0.35; p.armRX = -1.45 - sq(t * 13) * 0.35;
      p.armLZ = -0.1; p.armRZ = 0.1;
      p.armLY = (hash(n) - 0.5) * 0.4; p.armRY = (hash(n + 1) - 0.5) * 0.4;
      p.headX = 0.38; p.headY = (hash(Math.floor(n / 2)) - 0.5) * 0.8;
      p.torsoX = 0.15; p.torsoY = sq(t * 3) * 0.08;
      p.legLX = sq(t * 6) * 0.18; p.legRX = -p.legLX;
      return p;
    },
  },
};

interface Joints {
  body: THREE.Group; torsoPivot: THREE.Group; neck: THREE.Group;
  armL: THREE.Group; armR: THREE.Group; legL: THREE.Group; legR: THREE.Group;
}

export class Character {
  state: AnimState = 'idle';
  readonly ctx: AnimCtx = { syllable: 0, listening: false };
  onStateEnd: ((ended: AnimState) => void) | null = null;
  private stateTime = 0;
  private lastStep = -1;

  constructor(readonly root: THREE.Group, private j: Joints, private shirt: GearShirt) {}

  setState(name: AnimState, { force = false } = {}): void {
    if (this.state === name && !force) return;
    this.state = name;
    this.stateTime = 0;
    this.lastStep = -1;
  }

  syllable(): void {
    this.ctx.syllable++;
    this.lastStep = -1;
  }

  update(dt: number): void {
    const st = STATES[this.state];
    this.stateTime += dt;
    if (st.duration && this.stateTime >= st.duration) {
      const ended = this.state;
      this.setState('idle');
      this.onStateEnd?.(ended);
      return this.update(0);
    }
    const step = Math.floor(this.stateTime * st.fps);
    if (step === this.lastStep) return; // hold the frame: this is what makes it choppy
    this.lastStep = step;
    const n = step + this.ctx.syllable * 1000;
    // choppiness at 15 fps: now and then a frame is dropped, and sometimes the
    // pose sticks for a few frames before snapping ahead, like a bad tape
    if (step > 0 && hash(n + 0.5) > 0.88) return;
    if (step > 0 && step % 4 !== 0 && hash(Math.floor(step / 4) + this.ctx.syllable * 31 + 0.77) > 0.8) return;
    const p = st.pose(step / st.fps, n, this.ctx);
    const jit = (k: number) => (hash(n * 7 + k) - 0.5) * 0.06;

    const { body, torsoPivot, neck, armL, armR, legL, legR } = this.j;
    body.position.y = p.bodyY;
    body.rotation.y = p.bodyTurn;
    torsoPivot.rotation.set(p.torsoX + jit(1), p.torsoY, p.torsoZ + jit(2));
    neck.rotation.set(p.headX + jit(3), p.headY + jit(4), p.headZ + jit(5));
    armL.rotation.set(p.armLX + jit(6), p.armLY, p.armLZ + jit(7));
    armR.rotation.set(p.armRX + jit(8), p.armRY, p.armRZ + jit(9));
    legL.rotation.x = p.legLX;
    legR.rotation.x = p.legRX;

    // summon: flicker in and out of existence while rising
    this.root.visible = this.state !== 'summon' || (this.stateTime > 0.3 && (this.stateTime > 2.0 || hash(n * 3) > 0.35));

    // gears turn in jerky ticks while he thinks / works
    if (this.state === 'doing') this.shirt.turn(0.35);
    else if (this.state === 'thinking') this.shirt.turn(0.12);
    else if (this.state === 'summon' && step % 2 === 0) this.shirt.turn(-0.2);
  }
}
