// User — the character. Built from the 2006 figure FBX, re-rigged with simple
// joint pivots and animated in a deliberately choppy, stop-motion way.
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const BLUE = 0x0000ff;
const BLACK = 0x000000;
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
  // truly black: unlit, so the blue night light can't tint it navy (only the blue rim shows, like the photo)
  const matBlack = new THREE.MeshBasicMaterial({ color: BLACK, fog: false });
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

  // ---- props for drawing: a notebook (held in front of his chest) and a pen (in his right hand)
  const pageMat = new THREE.MeshBasicMaterial({ color: 0xe2e6ff }); // the page, a little moonlit; gets the paint canvas
  // bright enough to read against him at night: a red cover and white paper edges that glow a little
  const edgeMat = new THREE.MeshLambertMaterial({ color: 0xf0ece0, emissive: 0x55534c });
  const coverMat = new THREE.MeshLambertMaterial({ color: 0xd8382a, emissive: 0x6a1410 });
  // box faces: +x, -x, +y, -y, +z (the page), -z (the cover)
  const notebook = new THREE.Mesh(new THREE.BoxGeometry(190, 142, 10), [edgeMat, edgeMat, edgeMat, edgeMat, pageMat, coverMat]);
  notebook.castShadow = true;
  const note = new THREE.Group();
  note.add(notebook);
  note.visible = false;
  torsoPivot.add(note);
  const pen = new THREE.Group();
  const penBody = new THREE.Mesh(new THREE.CylinderGeometry(4, 3, 70, 8), new THREE.MeshLambertMaterial({ color: 0x111116 }));
  const penCap = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 16, 8), matBlue);
  penCap.position.y = 30;
  pen.add(penBody, penCap);
  pen.position.set(0, -192, 18);
  pen.rotation.x = 0.7;
  pen.visible = false;
  armR.add(pen);

  return new Character(root, { body, torsoPivot, neck, armL, armR, legL, legR, note, pen }, shirt, pageMat);
}

// ---------------------------------------------------------------- animation
// Hand-keyed poses, sampled like stop-motion: the pose only changes at 15 fps, frames
// are sometimes dropped or stick for a moment, and every frame gets a little jitter.
// Layers: a looping base clip per state + one-shot "acts"/gestures on top.

const POSE_KEYS = ['bodyX', 'bodyY', 'bodyZ', 'bodyTurn', 'shoulderY', 'torsoX', 'torsoY', 'torsoZ', 'headX', 'headY', 'headZ',
  'armLX', 'armLY', 'armLZ', 'armRX', 'armRY', 'armRZ', 'legLX', 'legLZ', 'legRX', 'legRZ',
  // props: the notebook (in torso space, model units) and the pen; *On > 0.5 = visible
  'noteOn', 'noteX', 'noteY', 'noteZ', 'noteTilt', 'noteFlip', 'noteSpin', 'penOn'] as const;
type PoseKey = (typeof POSE_KEYS)[number];
type Pose = Record<PoseKey, number>;
type Key = [time: number, pose: Partial<Pose>];
interface Clip { len: number; loop?: boolean; keys: Key[] }

const ZERO = Object.fromEntries(POSE_KEYS.map((k) => [k, 0])) as Pose;

export type AnimState = 'summon' | 'idle' | 'thinking' | 'responding' | 'waiting' | 'doing'
  | 'drawPrep' | 'drawPonder' | 'drawing' | 'drawDone' | 'drawHold' | 'drawReveal' | 'drawShow'
  | 'drawToss' | 'drawFlattered' | 'drawSad' | 'drawPutAway';
export const isDrawState = (s: AnimState) => s.startsWith('draw');
interface AnimCtx { listening: boolean }

// deterministic per-frame noise so a held frame stays exactly held
function hash(n: number): number { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));
function lerpPose(a: Pose, b: Pose, w: number, mask?: Set<PoseKey>): Pose {
  const out = { ...a };
  for (const k of mask ?? POSE_KEYS) out[k] = a[k] + (b[k] - a[k]) * w;
  return out;
}

// Each key inherits everything it doesn't set from the key before it.
class Compiled {
  readonly times: number[];
  readonly poses: Pose[];
  readonly mask = new Set<PoseKey>();
  constructor(readonly clip: Clip) {
    let prev = { ...ZERO };
    this.times = clip.keys.map(([t]) => t);
    this.poses = clip.keys.map(([, p]) => {
      for (const k of Object.keys(p) as PoseKey[]) this.mask.add(k);
      prev = { ...prev, ...p };
      return prev;
    });
  }
  sample(t: number): Pose {
    const { times, poses, clip } = this;
    const tt = clip.loop ? ((t % clip.len) + clip.len) % clip.len : Math.min(t, clip.len);
    let i = times.length - 1;
    while (i > 0 && times[i] > tt) i--;
    const last = i === times.length - 1;
    if (last && !clip.loop) return poses[i];
    const t1 = last ? clip.len : times[i + 1];
    const next = last ? poses[0] : poses[i + 1];
    return lerpPose(poses[i], next, ease((tt - times[i]) / Math.max(1e-6, t1 - times[i])));
  }
}
const C = (clip: Clip) => new Compiled(clip);

// ---- base clips (loop) --------------------------------------------------------------
const BASE = {
  // standing alone: breathing, head hung, slow slumps
  idle: C({ len: 6, loop: true, keys: [
    [0, { headX: 0.24, headZ: 0.08, torsoX: 0.04, armLX: 0.03, armRX: 0.02, armLZ: 0.06, armRZ: -0.06 }],
    [2.0, { headX: 0.32, headZ: 0.14, torsoX: 0.08, armLX: 0.07, armRX: 0.06, bodyY: -3 }],
    [3.2, { headX: 0.27, headZ: 0.05 }],
    [4.6, { headX: 0.2, headZ: 0.12, torsoX: 0.03, bodyY: 0, headY: 0.06 }],
  ] }),
  // staring at you, head tilted, weight shifting from leg to leg
  waiting: C({ len: 5, loop: true, keys: [
    [0, { headX: -0.02, headZ: 0.22, armLX: -0.2, armRX: -0.16, armLZ: 0.1, armRZ: -0.1 }],
    [1.6, { headZ: 0.3, bodyX: 6, torsoZ: -0.03, legLZ: 0.04 }],
    [3.2, { headZ: 0.18, bodyX: -5, torsoZ: 0.03, legLZ: 0, legRZ: -0.04 }],
  ] }),
  // you're talking: leaning in, hand cupped by his ear, nodding along
  listening: C({ len: 2.4, loop: true, keys: [
    [0, { torsoX: 0.14, headX: 0.05, headZ: 0.36, headY: -0.15, armLX: -2.35, armLZ: -0.55, armRX: -0.15, armRZ: -0.08 }],
    [0.6, { headX: 0.15 }],
    [1.2, { headX: 0.04 }],
    [1.8, { headX: 0.13, headZ: 0.4 }],
  ] }),
  // hand pressed to his head, tapping, swaying while he stares at the floor
  thinking: C({ len: 4, loop: true, keys: [
    [0, { armRX: -2.55, armRZ: 0.55, armLX: -0.8, armLZ: -0.4, headX: 0.32, headZ: -0.2, headY: 0.1, torsoX: 0.08, torsoZ: 0.03 }],
    [0.65, { armRX: -2.72 }],
    [1.3, { armRX: -2.55, headY: -0.15, torsoZ: -0.04, headZ: -0.26, bodyX: -4 }],
    [1.95, { armRX: -2.72 }],
    [2.6, { armRX: -2.55, headY: 0.18, torsoZ: 0.05, headZ: -0.16, bodyX: 4 }],
    [3.3, { armRX: -2.72 }],
  ] }),
  // talking: loose arms, small bounce (gestures come from his words, see GESTURES)
  responding: C({ len: 1.6, loop: true, keys: [
    [0, { headX: 0.02, headZ: 0.1, armLX: -0.45, armRX: -0.4, armLZ: 0.12, armRZ: -0.12, torsoX: 0.05 }],
    [0.4, { armLX: -0.6, armRX: -0.3, headZ: 0.16, bodyY: -2 }],
    [0.8, { armLX: -0.4, armRX: -0.55, headZ: 0.06, bodyY: 0 }],
    [1.2, { armLX: -0.55, armRX: -0.35, headZ: 0.14 }],
  ] }),
  // working invisible levers: fast thrust, hold, swap
  doing: C({ len: 0.8, loop: true, keys: [
    [0, { torsoX: 0.16, headX: 0.4, armLX: -1.2, armRX: -1.7, armLZ: -0.12, armRZ: 0.12, legLX: 0.1, legRX: -0.1 }],
    [0.13, { armLX: -1.75, armRX: -1.15, bodyY: -3 }],
    [0.4, { bodyY: 0 }],
    [0.53, { armLX: -1.2, armRX: -1.7, legLX: -0.1, legRX: 0.1, bodyY: -3 }],
  ] }),
};

// ---- summon (one-shot, 3.8 s): he climbs up out of the ground ------------------------
// Model units: feet at 0, shoulders at 380, top of head ~524, arms reach 180 from the shoulder.
// bodyY is how far below the ground he is, so the floor hides whatever hasn't come out yet.
const SUMMON = C({ len: 3.8, keys: [
  // shoulderY stretches the arms up out of their sockets (a stop-motion cheat) so the
  // hands clearly break through the ground well before his head does
  [0, { bodyY: -720, shoulderY: 130, armLX: -3.1, armRX: -3.1, armLZ: 0.1, armRZ: -0.1, headX: 0.8, torsoX: 0 }],
  [0.35, { bodyY: -560, armLZ: 0.25, armRZ: -0.25 }], // hands punch up through the ground
  [0.5, { bodyY: -530, armLX: -2.7, armRX: -3.1 }], // clawing at the air
  [0.62, { bodyY: -520, armLX: -3.1, armRX: -2.7 }],
  [0.75, { bodyY: -385, shoulderY: 0, armLX: -0.4, armRX: -0.4, armLZ: 1.55, armRZ: -1.55, headX: 0.5, torsoX: 0.25 }], // arms slam flat on the ground
  [1.1, { bodyY: -372 }],
  [1.35, { bodyY: -290, armLZ: 1.05, armRZ: -1.05, torsoX: 0.35, headX: 0.6 }], // first pull
  [1.55, { bodyY: -305, armLZ: 1.12, armRZ: -1.12 }], // slips back a little
  [1.8, { bodyY: -170, armLX: -0.15, armRX: -0.15, armLZ: 0.4, armRZ: -0.4, torsoX: 0.55 }], // second pull
  [2.05, { bodyY: -60, legLX: -1.25, armLX: 0.2, armRX: 0.2, armLZ: 0.25, armRZ: -0.25, torsoX: 0.5 }], // one leg steps out
  [2.35, { bodyY: 0, legLX: 0, legRX: -0.2, armLX: 0, armRX: 0, armLZ: 0.08, armRZ: -0.08, torsoX: 0.45, headX: 0.6 }], // up, hunched
  [2.5, { legRX: 0 }],
  [2.6, { bodyY: -6, torsoX: 0.4 }],
  [2.75, { bodyY: 0, headX: -0.1, headZ: 0.25, torsoX: 0.1 }], // head snaps up at you
  [3.15, { armLX: -1.45, armRX: -1.35, armLZ: 0.32, armRZ: -0.38, torsoX: 0.12, headX: 0.1, headZ: 0.18 }], // reaches out (the photo)
  [3.8, { armLX: -1.5, armRX: -1.4 }],
] });
const SUMMON_STARE_AT = 2.75;
// moments the ground breaks: [time, x offset in studs (0 = around him), how many chunks]
const SUMMON_DEBRIS: [number, number, number][] = [[0.35, 0, 14], [0.75, 3.2, 8], [0.75, -3.2, 8], [1.35, 0, 6], [1.8, 0, 6], [2.05, 0.6, 8]];

// ---- drawing ------------------------------------------------------------------------
// Notebook positions are in torso space (model units): chest front is z = 50.
// noteFlip 0 = page toward him, cover toward you; 1 = page toward you.
const NOTE_DRAW = { noteOn: 1, noteX: 0, noteY: 105, noteZ: 115, noteTilt: 1.0, noteFlip: 0, noteSpin: 0 }; // lying in his hand, page up
const NOTE_SHOW = { noteOn: 1, noteX: 0, noteY: 150, noteZ: 150, noteTilt: 0, noteSpin: 0 }; // held up in front of him
const HOLD_LEFT = { armLX: -1.1, armLZ: -0.75 }; // left hand under the notebook
const PEN_ON_PAGE = { armRX: -1.15, armRZ: 0.7 };
const BOTH_HOLD = { armLX: -1.3, armLZ: -0.4, armRX: -1.3, armRZ: 0.4 }; // both hands on its edges
const DRAW = {
  // takes the notebook from behind his back, then the pen from his pocket
  drawPrep: C({ len: 2.6, keys: [
    [0, { noteOn: 0, penOn: 0, noteX: 170, noteY: 30, noteZ: -90, noteTilt: 0, noteFlip: 0, noteSpin: 0, armLX: 0, armLZ: 0.06, armRX: 0, armRZ: -0.06, headX: 0.1, headY: 0, headZ: 0.1, torsoX: 0.04, torsoY: 0 }],
    [0.4, { armLX: 0.75, armLZ: 0.2, torsoY: -0.25, headY: -0.45, headX: 0.25 }], // reaches behind his back
    [0.6, { noteOn: 1 }],
    [0.8, {}],
    [1.3, { ...NOTE_DRAW, noteTilt: 0.4, ...HOLD_LEFT, torsoY: 0, headY: 0, headX: 0.35 }], // brings it round in front
    [1.6, { armRX: -0.25, armRZ: -0.3, headX: 0.5, headY: 0.2 }], // right hand to his pocket
    [1.8, { penOn: 1 }],
    [2.2, { ...PEN_ON_PAGE, noteTilt: 1.0, headY: 0, headX: 0.5 }],
  ] }),
  // pen tapping his chin while he works out what to draw
  drawPonder: C({ len: 2.4, loop: true, keys: [
    [0, { ...NOTE_DRAW, ...HOLD_LEFT, penOn: 1, armRX: -2.15, armRZ: 0.65, headX: -0.2, headY: 0.25, headZ: -0.1, torsoX: 0.05 }],
    [0.6, { armRX: -2.3 }],
    [1.2, { armRX: -2.15, headY: -0.15, headX: -0.3 }],
    [1.8, { armRX: -2.3 }],
  ] }),
  // scribbling, eyes on the page
  drawing: C({ len: 1.2, loop: true, keys: [
    [0, { ...NOTE_DRAW, ...HOLD_LEFT, ...PEN_ON_PAGE, penOn: 1, headX: 0.5, headY: 0, headZ: 0, torsoX: 0.08 }],
    [0.15, { armRX: -1.25, armRZ: 0.55 }],
    [0.3, { armRX: -1.08, armRZ: 0.8 }],
    [0.45, { armRX: -1.2, armRZ: 0.6, headZ: 0.05 }],
    [0.6, { armRX: -1.1, armRZ: 0.75 }],
    [0.75, { armRX: -1.28, armRZ: 0.65, headZ: -0.05 }],
    [0.9, { armRX: -1.12, armRZ: 0.5 }],
    [1.05, { armRX: -1.22, armRZ: 0.72 }],
  ] }),
  // clicks the pen, puts it away, holds the drawing up (back toward you) and looks at you
  drawDone: C({ len: 2.3, keys: [
    [0, { ...NOTE_DRAW, ...HOLD_LEFT, ...PEN_ON_PAGE, penOn: 1, headX: 0.5, headY: 0, headZ: 0, torsoX: 0.08 }],
    [0.25, { armRX: -1.55, armRZ: 0.6, headX: 0.35 }], // lifts the pen...
    [0.35, { armRX: -1.48 }], // ...click
    [0.8, { armRX: -0.25, armRZ: -0.3, headX: 0.4 }], // into his pocket
    [1.0, { penOn: 0 }],
    [1.15, {}],
    [1.8, { ...NOTE_SHOW, noteFlip: 0, ...BOTH_HOLD, headX: -0.05, headZ: 0.2, torsoX: 0.04 }],
  ] }),
  // "do you want to see it?"
  drawHold: C({ len: 3, loop: true, keys: [
    [0, { ...NOTE_SHOW, noteFlip: 0, ...BOTH_HOLD, penOn: 0, headX: -0.05, headZ: 0.2, torsoX: 0.04 }],
    [1.5, { headZ: 0.3, noteY: 136 }],
  ] }),
  // turns it around to show you
  drawReveal: C({ len: 1.1, keys: [
    [0, { ...NOTE_SHOW, noteFlip: 0, ...BOTH_HOLD, penOn: 0, headX: -0.05, headZ: 0.2, torsoX: 0.04 }],
    [0.2, { noteY: 152 }],
    [0.75, { noteFlip: 1, noteY: 140 }],
  ] }),
  // holding it up for you, a little nervous
  drawShow: C({ len: 3, loop: true, keys: [
    [0, { ...NOTE_SHOW, noteFlip: 1, ...BOTH_HOLD, penOn: 0, headX: -0.05, headZ: 0.2, torsoX: 0.04, bodyY: 0 }],
    [1.5, { headZ: 0.1, headX: -0.1, bodyY: 3 }],
  ] }),
  // you liked it: bashful, hand behind his head, twisting
  drawFlattered: C({ len: 3.4, keys: [
    [0, { ...NOTE_SHOW, noteFlip: 1, ...BOTH_HOLD, penOn: 0, headX: -0.05, headZ: 0.2, torsoX: 0.04, torsoY: 0, bodyY: 0 }],
    [0.4, { noteX: 40, noteY: 95, noteZ: 110, noteTilt: 0.2, armLX: -0.85, armLZ: -0.45, armRX: -2.85, armRZ: 0.95, headX: 0.35, headZ: -0.25, torsoY: 0.2 }],
    [0.9, { torsoY: -0.2, headZ: -0.15, armRX: -2.7 }],
    [1.4, { torsoY: 0.2, headZ: -0.25, armRX: -2.85 }],
    [1.9, { torsoY: -0.15, armRX: -2.7, bodyY: 4 }],
    [2.4, { torsoY: 0.1, bodyY: 0, armRX: -2.85 }],
    [3.0, { torsoY: 0, armRX: -0.2, armRZ: -0.1, headX: 0.15, headZ: 0.1 }],
  ] }),
  // you didn't like it: lowers it, head hung
  drawSad: C({ len: 2.0, keys: [
    [0, { ...NOTE_SHOW, noteFlip: 1, ...BOTH_HOLD, penOn: 0, headX: -0.05, headZ: 0.2, torsoX: 0.04 }],
    [0.5, { noteY: 90, noteZ: 105, noteTilt: -0.3, armLX: -0.7, armLZ: -0.5, armRX: -0.7, armRZ: 0.5, headX: 0.55, headZ: 0.1, torsoX: 0.15 }],
  ] }),
  // tucks the notebook back behind his back
  drawPutAway: C({ len: 1.6, keys: [
    [0, { noteOn: 1, noteX: 20, noteY: 95, noteZ: 110, noteTilt: 0.2, noteFlip: 1, noteSpin: 0, penOn: 0, armLX: -0.85, armLZ: -0.45, armRX: -0.1, armRZ: -0.1, headX: 0.2, headY: 0, torsoX: 0.06, torsoY: 0 }],
    [0.5, { noteX: 170, noteY: 30, noteZ: -90, armLX: 0.75, armLZ: 0.2, torsoY: -0.25, headY: -0.3 }],
    [0.8, { noteOn: 0 }],
    [1.3, { armLX: 0, armLZ: 0.06, torsoY: 0, headY: 0, headX: 0.1 }],
  ] }),
  // you didn't want to see it: throws it up in the air, where it explodes
  drawToss: C({ len: 2.6, keys: [
    [0, { ...NOTE_SHOW, noteFlip: 0, ...BOTH_HOLD, penOn: 0, headX: -0.05, headZ: 0.2, torsoX: 0.04, bodyY: 0 }],
    [0.25, { noteY: 90, noteZ: 120, armLX: -0.8, armRX: -0.8, armLZ: -0.55, armRZ: 0.55, torsoX: 0.2, headX: 0.3, bodyY: -6 }], // wind up
    [0.45, { noteY: 420, noteZ: 160, noteSpin: 2.5, armLX: -2.9, armRX: -2.9, armLZ: -0.1, armRZ: 0.1, torsoX: -0.1, headX: -0.4, bodyY: 4 }], // throw!
    [0.75, { noteY: 620, noteSpin: 5 }],
    [0.8, { noteOn: 0 }],
    [1.3, { armLX: -0.3, armRX: -0.3, armLZ: 0.1, armRZ: -0.1, headX: -0.5, bodyY: 0, torsoX: 0 }], // watches the scraps fall
    [2.0, { armLX: 0, armRX: 0, armLZ: 0.06, armRZ: -0.06, headX: 0.45, headZ: 0.15, torsoX: 0.1 }], // looks down
  ] }),
};
const TOSS_EXPLODE_AT = 0.7;
/** One-shot states and what comes after them. */
const NEXT: Partial<Record<AnimState, AnimState>> = {
  summon: 'idle', drawPrep: 'drawPonder', drawDone: 'drawHold', drawReveal: 'drawShow',
  drawToss: 'idle', drawFlattered: 'drawPutAway', drawSad: 'drawPutAway', drawPutAway: 'waiting',
};
const CLIPS: Record<string, Compiled> = { ...BASE, ...DRAW, summon: SUMMON };

// ---- acts: little things he does on his own -----------------------------------------
const ACTS = {
  lookAround: C({ len: 3.2, keys: [[0, { headY: 0, headX: 0.2 }], [0.4, { headY: 0.7, headX: 0.05 }], [1.2, { headY: 0.72 }], [1.5, { headY: -0.65 }], [2.3, { headY: -0.68 }], [2.7, { headY: 0, headX: 0.2 }]] }),
  glanceBehind: C({ len: 2.4, keys: [[0, { headY: 0, torsoY: 0, headX: 0.2 }], [0.15, { headY: 1.25, torsoY: 0.35, headX: -0.05 }], [1.3, { headY: 1.2 }], [1.45, { headY: 0.1, torsoY: 0, headX: 0 }], [2.4, { headY: 0 }]] }),
  sigh: C({ len: 3, keys: [[0, { torsoX: 0.04, headX: 0.24, bodyY: 0, armLZ: 0.06, armRZ: -0.06 }], [0.8, { torsoX: -0.06, headX: -0.1, bodyY: 4 }], [1.6, { torsoX: 0.2, headX: 0.55, bodyY: -8, armLZ: 0.02, armRZ: -0.02 }], [2.6, {}], [3, { torsoX: 0.04, headX: 0.24, bodyY: 0, armLZ: 0.06, armRZ: -0.06 }]] }),
  lookAtHands: C({ len: 3.4, keys: [[0, { armLX: 0, armRX: 0, armLZ: 0.06, armRZ: -0.06, headX: 0.24 }], [0.5, { armLX: -1.0, armRX: -0.95, armLZ: -0.18, armRZ: 0.2, headX: 0.6 }], [1.5, { armLX: -1.08, armRX: -0.88 }], [2.6, { armLX: -0.98, armRX: -0.98 }], [3.4, { armLX: 0, armRX: 0, armLZ: 0.06, armRZ: -0.06, headX: 0.24 }]] }),
  lookUp: C({ len: 3, keys: [[0, { headX: 0.24, headZ: 0.1 }], [0.6, { headX: -0.55, headZ: 0 }], [2.2, { headX: -0.6 }], [3, { headX: 0.24, headZ: 0.1 }]] }),
  stare: C({ len: 3.6, keys: [[0, { headX: 0.24, headZ: 0.1, headY: 0 }], [0.15, { headX: -0.02, headZ: 0, headY: 0 }], [3.0, {}], [3.6, { headX: 0.24, headZ: 0.1 }]] }),
  weightShift: C({ len: 2.6, keys: [[0, { bodyX: 0, legLZ: 0, torsoZ: 0 }], [0.6, { bodyX: 10, legLZ: 0.08, torsoZ: -0.05 }], [1.9, {}], [2.6, { bodyX: 0, legLZ: 0, torsoZ: 0 }]] }),
  scratchHead: C({ len: 2.8, keys: [[0, { armRX: 0, armRZ: -0.06, headZ: 0.1 }], [0.5, { armRX: -2.7, armRZ: 0.65, headZ: -0.15 }], [0.8, { armRX: -2.86 }], [1.1, { armRX: -2.64 }], [1.4, { armRX: -2.86 }], [1.7, { armRX: -2.64 }], [2.2, {}], [2.8, { armRX: 0, armRZ: -0.06, headZ: 0.1 }]] }),
  wave: C({ len: 2.8, keys: [[0, { armLX: -0.2, armLZ: 0.1, headZ: 0.22 }], [0.4, { armLX: -0.3, armLZ: 2.5, headZ: 0.3 }], [0.75, { armLZ: 2.85 }], [1.1, { armLZ: 2.45 }], [1.45, { armLZ: 2.85 }], [1.8, { armLZ: 2.5 }], [2.3, {}], [2.8, { armLX: -0.2, armLZ: 0.1, headZ: 0.22 }]] }),
  peer: C({ len: 2.6, keys: [[0, { torsoX: 0, headX: -0.02 }], [0.6, { torsoX: 0.28, headX: -0.25 }], [2.0, {}], [2.6, { torsoX: 0, headX: -0.02 }]] }),
  tiltOther: C({ len: 2.4, keys: [[0, { headZ: 0.22 }], [0.5, { headZ: -0.3 }], [1.8, {}], [2.4, { headZ: 0.22 }]] }),
  thinkLookUp: C({ len: 2.6, keys: [[0, { headX: 0.32, headY: 0.1 }], [0.4, { headX: -0.45, headY: 0.35 }], [2, {}], [2.6, { headX: 0.32, headY: 0.1 }]] }),
  pace: C({ len: 3.2, keys: [[0, { legLX: 0, legRX: 0, bodyY: 0, bodyX: 0 }], [0.4, { legLX: -0.35, bodyY: 4, bodyX: -4 }], [0.8, { legLX: 0, bodyY: 0 }], [1.2, { legRX: -0.35, bodyY: 4, bodyX: 4 }], [1.6, { legRX: 0, bodyY: 0 }], [2.0, { legLX: -0.35, bodyY: 4, bodyX: -4 }], [2.4, { legLX: 0, bodyY: 0 }], [2.8, { legRX: -0.35, bodyY: 4, bodyX: 4 }], [3.2, { legRX: 0, bodyY: 0, bodyX: 0 }]] }),
  checkCamera: C({ len: 1.4, keys: [[0, { headX: 0.4, headY: 0 }], [0.1, { headX: -0.05 }], [1.0, {}], [1.1, { headX: 0.4 }]] }),
  bigPress: C({ len: 1.2, keys: [[0, { armRX: -1.7, torsoX: 0.16, bodyY: 0 }], [0.3, { armRX: -2.6, torsoX: 0.02 }], [0.5, {}], [0.62, { armRX: -1.2, torsoX: 0.3, bodyY: -6 }], [1.0, {}], [1.2, { armRX: -1.7, torsoX: 0.16, bodyY: 0 }]] }),
};
type ActName = keyof typeof ACTS;
const STATE_ACTS: Partial<Record<AnimState | 'listening', { acts: ActName[]; every: [number, number] }>> = {
  idle: { acts: ['lookAround', 'glanceBehind', 'sigh', 'lookAtHands', 'lookUp', 'stare', 'weightShift', 'scratchHead'], every: [2.5, 6] },
  waiting: { acts: ['stare', 'wave', 'peer', 'tiltOther', 'weightShift'], every: [3, 7] },
  thinking: { acts: ['thinkLookUp', 'pace'], every: [2, 4.5] },
  doing: { acts: ['checkCamera', 'bigPress'], every: [1.2, 2.8] },
};

// ---- when you click him: knocked back, head shake, brushes himself off (3.9 s) ---------
// bodyZ < 0 is away from the camera (he faces +Z).
const POKE = C({ len: 3.9, keys: [
  [0, { bodyZ: 0, torsoX: 0.04, torsoZ: 0, headX: 0.1, headY: 0, headZ: 0.1, armLX: 0, armRX: 0, armLZ: 0.06, armRZ: -0.06, legLX: 0, legRX: 0 }],
  [0.1, { bodyZ: -35, torsoX: -0.38, headX: -0.5, headZ: 0.25, armLX: -1.05, armRX: -0.9, armLZ: 0.75, armRZ: -0.7, legRX: 0.35 }], // the push lands
  [0.35, { bodyZ: -58, torsoX: -0.2, torsoZ: -0.08, headX: -0.25, armLX: -0.6, armRX: -0.5, armLZ: 0.45, armRZ: -0.4, legRX: 0, legLX: 0.25 }], // staggers back a step
  [0.6, { bodyZ: -52, torsoX: 0.06, torsoZ: 0, headX: 0.15, headZ: 0.1, armLX: -0.1, armRX: -0.1, armLZ: 0.15, armRZ: -0.15, legLX: 0 }], // catches himself
  [0.8, { headY: 0.38 }], // shakes it off
  [0.95, { headY: -0.38 }],
  [1.1, { headY: 0.32 }],
  [1.25, { headY: -0.25 }],
  [1.4, { headY: 0, headX: 0.45, torsoX: 0.1 }], // looks down at himself
  [1.55, { armRX: -1.25, armRZ: 0.85 }], // right hand brushes his chest...
  [1.7, { armRX: -0.95, armRZ: 0.4 }],
  [1.85, { armRX: -1.3, armRZ: 0.85 }],
  [2.0, { armRX: -0.95, armRZ: 0.4 }],
  [2.15, { armRX: -0.1, armRZ: -0.1, armLX: -1.25, armLZ: -0.85 }], // ...then the left hand
  [2.3, { armLX: -0.95, armLZ: -0.4 }],
  [2.45, { armLX: -1.3, armLZ: -0.85 }],
  [2.6, { armLX: -0.1, armLZ: 0.1, torsoX: 0.38, headX: 0.55, armRX: -0.45, armRZ: 0.2 }], // bends to dust off his legs
  [2.75, { armRX: -0.15, armRZ: 0.05 }],
  [2.9, { armRX: -0.45, armRZ: 0.2 }],
  [3.05, { armRX: -0.15, armRZ: 0.05 }],
  [3.3, { torsoX: 0.04, headX: 0.1, armRX: 0, armRZ: -0.06, armLZ: 0.06, bodyZ: -20, legLX: -0.25 }], // steps back to his spot
  [3.6, { bodyZ: 0, legLX: 0 }],
] });

// ---- gestures while talking, chosen from the words he's saying -----------------------
const rest = { armLX: -0.45, armRX: -0.4, armLZ: 0.12, armRZ: -0.12, headX: 0.02, headY: 0, headZ: 0.1, torsoX: 0.05, bodyY: 0 };
const GESTURES = {
  pointYou: C({ len: 1.6, keys: [[0, { armRX: rest.armRX, armRZ: rest.armRZ, headX: 0.02 }], [0.25, { armRX: -1.55, armRZ: 0.12, headX: -0.06 }], [1.2, {}], [1.6, { armRX: rest.armRX, armRZ: rest.armRZ, headX: 0.02 }]] }),
  handChest: C({ len: 1.6, keys: [[0, { armRX: rest.armRX, armRZ: rest.armRZ, headX: 0.02 }], [0.3, { armRX: -1.1, armRZ: 0.8, headX: 0.2 }], [1.2, {}], [1.6, { armRX: rest.armRX, armRZ: rest.armRZ, headX: 0.02 }]] }),
  shrug: C({ len: 1.4, keys: [[0, { armLX: rest.armLX, armRX: rest.armRX, armLZ: rest.armLZ, armRZ: rest.armRZ, headZ: 0.1, bodyY: 0 }], [0.3, { armLX: -0.75, armRX: -0.75, armLZ: 0.55, armRZ: -0.55, headZ: 0.32, bodyY: 4 }], [1.0, {}], [1.4, { armLX: rest.armLX, armRX: rest.armRX, armLZ: rest.armLZ, armRZ: rest.armRZ, headZ: 0.1, bodyY: 0 }]] }),
  headShake: C({ len: 1.2, keys: [[0, { headY: 0 }], [0.15, { headY: 0.32 }], [0.35, { headY: -0.32 }], [0.55, { headY: 0.28 }], [0.75, { headY: -0.22 }], [0.95, { headY: 0 }]] }),
  nod: C({ len: 0.9, keys: [[0, { headX: 0.02 }], [0.15, { headX: 0.3 }], [0.35, { headX: -0.02 }], [0.55, { headX: 0.25 }], [0.75, { headX: 0.02 }]] }),
  hugSelf: C({ len: 2.2, keys: [[0, { ...rest }], [0.35, { armLX: -1.2, armRX: -1.15, armLZ: -0.85, armRZ: 0.85, headX: 0.35, torsoX: 0.15 }], [1.8, {}], [2.2, { ...rest }]] }),
  present: C({ len: 1.6, keys: [[0, { armLX: rest.armLX, armLZ: rest.armLZ, headY: 0 }], [0.3, { armLX: -1.0, armLZ: 0.75, headY: 0.25 }], [1.2, {}], [1.6, { armLX: rest.armLX, armLZ: rest.armLZ, headY: 0 }]] }),
  droop: C({ len: 1.6, keys: [[0, { headX: 0.02, torsoX: 0.05 }], [0.4, { headX: 0.5, torsoX: 0.15 }], [1.2, {}], [1.6, { headX: 0.02, torsoX: 0.05 }]] }),
  beatL: C({ len: 0.8, keys: [[0, { armLX: rest.armLX }], [0.15, { armLX: -1.05 }], [0.5, { armLX: -0.8 }], [0.8, { armLX: rest.armLX }]] }),
  beatR: C({ len: 0.8, keys: [[0, { armRX: rest.armRX }], [0.15, { armRX: -1.1 }], [0.5, { armRX: -0.8 }], [0.8, { armRX: rest.armRX }]] }),
};
type GestureName = keyof typeof GESTURES;
const WORD_GESTURES: [RegExp, GestureName][] = [
  [/\b(alone|lonely|dark|cold|empty|scared|afraid|sad|lost)\b/i, 'hugSelf'],
  [/\b(no|not|don'?t|can'?t|never|nothing|nobody|won'?t)\b/i, 'headShake'],
  [/\b(you|your|yours|you'?re)\b/i, 'pointYou'],
  [/\b(i|me|my|i'?m|myself|mine)\b/i, 'handChest'],
  [/\?/, 'shrug'],
  [/\b(yes|yeah|okay|ok|sure|done|right)\b/i, 'nod'],
  [/\b(here|there|this|look|opened|open|see)\b/i, 'present'],
  [/(\.\.\.|…)/, 'droop'],
];

// Dirt chunks and a dark hole in the ground for the summon.
class GroundBreak {
  readonly group = new THREE.Group();
  private chunks: { m: THREE.Mesh; v: THREE.Vector3; spin: THREE.Vector3; life: number }[] = [];
  private hole: THREE.Mesh;
  private holeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false });
  private chunkGeo = new THREE.BoxGeometry(1, 1, 1);
  private chunkMats = [0x0b1a0a, 0x101622, 0x07100a].map((c) => new THREE.MeshLambertMaterial({ color: c }));

  constructor() {
    // a jagged, torn opening rather than a perfect circle
    const shape = new THREE.Shape();
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = 1.7 + hash(i * 3.1) * 0.6 + (i % 3 === 0 ? 0.35 : 0);
      if (i === 0) shape.moveTo(Math.cos(a) * r * 1.25, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r * 1.25, Math.sin(a) * r);
    }
    this.hole = new THREE.Mesh(new THREE.ShapeGeometry(shape), this.holeMat);
    this.hole.rotation.x = -Math.PI / 2;
    this.hole.position.y = 0.03;
    this.hole.renderOrder = 1;
    this.group.add(this.hole);
  }

  burst(x: number, count: number) {
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.chunkGeo, this.chunkMats[i % 3]);
      m.scale.setScalar(0.15 + Math.random() * 0.3);
      m.position.set(x + (Math.random() - 0.5) * 1.6, 0.1, (Math.random() - 0.5) * 1.2);
      m.castShadow = true;
      const v = new THREE.Vector3((Math.random() - 0.5) * 4 + Math.sign(x) * 1.5, 4 + Math.random() * 5, (Math.random() - 0.2) * 3);
      const spin = new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      this.chunks.push({ m, v, spin, life: 1.4 + Math.random() * 0.6 });
      this.group.add(m);
    }
  }

  /** Called every rendered frame: the dirt is the world, not User, so it moves smoothly. */
  step(dt: number, summonTime: number | null) {
    for (const c of this.chunks) {
      c.v.y -= 22 * dt;
      c.m.position.addScaledVector(c.v, dt);
      if (c.m.position.y < 0.05) { c.m.position.y = 0.05; c.v.multiplyScalar(0.3); c.v.y = Math.abs(c.v.y) * 0.3; }
      c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt;
      c.life -= dt;
      if (c.life <= 0) this.group.remove(c.m);
    }
    this.chunks = this.chunks.filter((c) => c.life > 0);
    // the hole tears open with his hands, then closes up in a few steps once he's out
    const t = summonTime;
    const o = t === null ? 0 : t < 0.35 ? 0 : t < 0.75 ? 0.6 : t < 2.6 ? 0.9 : Math.max(0, 0.9 - Math.floor((t - 2.6) * 5) * 0.15);
    this.holeMat.opacity = o;
    this.hole.visible = o > 0;
    this.hole.scale.setScalar(t !== null && t < 0.75 ? 0.6 : 1);
  }
}

interface Joints {
  body: THREE.Group; torsoPivot: THREE.Group; neck: THREE.Group;
  armL: THREE.Group; armR: THREE.Group; legL: THREE.Group; legR: THREE.Group;
  note: THREE.Group; pen: THREE.Group;
}

/** The drawing, torn to scraps: bits of paper and ink flying out of the explosion. */
class PaperBurst {
  readonly group = new THREE.Group();
  private geo = new THREE.PlaneGeometry(1, 1);
  private bits: { m: THREE.Mesh; v: THREE.Vector3; spin: THREE.Vector3; life: number; max: number }[] = [];

  burst(at: THREE.Vector3, inkColors: string[]) {
    for (let i = 0; i < 48; i++) {
      const c = i % 3 === 0 || !inkColors.length ? '#f4f1e8' : inkColors[i % inkColors.length];
      const m = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, transparent: true }));
      m.scale.set(0.12 + Math.random() * 0.28, 0.1 + Math.random() * 0.22, 1);
      m.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.3));
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      const max = 1.6 + Math.random() * 1.2;
      this.bits.push({ m, v: dir.multiplyScalar(3 + Math.random() * 6), spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12), life: max, max });
      this.group.add(m);
    }
  }

  step(dt: number) {
    for (const b of this.bits) {
      b.v.y -= 7 * dt;
      b.v.multiplyScalar(1 - Math.min(0.9, dt * 1.6)); // paper drifts
      b.m.position.addScaledVector(b.v, dt);
      if (b.m.position.y < 0.03) { b.m.position.y = 0.03; b.v.set(0, 0, 0); b.spin.multiplyScalar(0.5); }
      b.m.rotation.x += b.spin.x * dt; b.m.rotation.y += b.spin.y * dt; b.m.rotation.z += b.spin.z * dt;
      b.life -= dt;
      (b.m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, b.life / 0.6);
      if (b.life <= 0) { this.group.remove(b.m); (b.m.material as THREE.Material).dispose(); }
    }
    this.bits = this.bits.filter((b) => b.life > 0);
  }
}
interface Playing { clip: Compiled; start: number; fadeIn?: number }

export class Character {
  state: AnimState = 'idle';
  readonly ctx: AnimCtx = { listening: false };
  onStateEnd: ((ended: AnimState) => void) | null = null;

  private time = 0;
  private stateStart = 0;
  private lastStep = -1;
  private pose: Pose = { ...ZERO };
  private from: Pose = { ...ZERO }; // pose we're blending away from after a state change
  private blendStart = -10;
  private baseKey = 'idle';
  private action: Playing | null = null;
  private lastAct = '';
  private nextActAt = 3;
  private bob = 0;
  private ground = new GroundBreak();
  private debrisIdx = 0;
  private lastStepTime = 0;
  private paper = new PaperBurst();
  private noteGone = false; // exploded: hide the notebook until the next state
  private pageTex: THREE.CanvasTexture | null = null;
  /** ink colors to make the scraps from when the drawing explodes */
  inkColors: () => string[] = () => [];

  constructor(readonly root: THREE.Group, private j: Joints, private shirt: GearShirt, private pageMat: THREE.MeshBasicMaterial) {
    root.add(this.ground.group, this.paper.group);
  }

  /** Put the paint program's canvas on the notebook page. */
  setPage(canvas: HTMLCanvasElement): void {
    if (this.pageTex?.image !== canvas) {
      this.pageTex?.dispose();
      this.pageTex = new THREE.CanvasTexture(canvas);
      this.pageTex.colorSpace = THREE.SRGBColorSpace;
      this.pageMat.map = this.pageTex;
      this.pageMat.needsUpdate = true;
    }
    this.pageTex.needsUpdate = true;
  }

  /** The page changed (new ink): re-upload it. */
  pageChanged(): void {
    if (this.pageTex) this.pageTex.needsUpdate = true;
  }

  setState(name: AnimState, { force = false } = {}): void {
    if (this.state === name && !force) return;
    this.state = name;
    this.stateStart = this.time;
    this.noteGone = false;
    if (name === 'summon') this.debrisIdx = 0;
    this.beginBlend();
    this.action = null;
    this.scheduleAct(0.6);
  }

  /** Called each time a new chunk of his words is spoken. */
  speakChunk(words: string): void {
    this.bob = 1;
    this.lastStep = -1; // react on this very frame
    if (isDrawState(this.state)) return; // hands are busy with the notebook: only the head bobs
    if (this.action && this.time - this.action.start < this.action.clip.clip.len * 0.6) return;
    const hit = WORD_GESTURES.find(([re]) => re.test(words));
    let g: GestureName | null = hit ? hit[1] : null;
    if (!g && Math.random() < 0.7) g = Math.random() < 0.5 ? 'beatL' : 'beatR';
    if (g) this.action = { clip: GESTURES[g], start: this.time };
  }

  /** You clicked him. Returns false if he can't react right now (still climbing out). */
  poke(): boolean {
    if (this.state === 'summon' || isDrawState(this.state)) return false;
    if (this.action?.clip === POKE && this.time - this.action.start < 0.6) return false; // already reeling
    this.action = { clip: POKE, start: this.time, fadeIn: 0.04 }; // the push lands instantly
    this.lastStep = -1;
    return true;
  }

  /** Is the given ray pointing at him (his body, not the dirt around him)? */
  hitBy(ray: THREE.Raycaster): boolean {
    return ray.intersectObject(this.j.body, true).length > 0;
  }

  /** Play a named act or gesture right now (used by the animation reel / debugging). */
  playAct(name: string): void {
    const clip = (ACTS as Record<string, Compiled>)[name] ?? (GESTURES as Record<string, Compiled>)[name];
    if (clip) { this.action = { clip, start: this.time }; this.lastStep = -1; }
  }

  private beginBlend() {
    this.from = { ...this.pose };
    this.blendStart = this.time;
  }

  private scheduleAct(min?: number) {
    const cfg = STATE_ACTS[this.ctx.listening ? 'listening' : this.state];
    if (!cfg) { this.nextActAt = Infinity; return; }
    const [a, b] = cfg.every;
    this.nextActAt = this.time + (min ?? 0) + a + Math.random() * (b - a);
  }

  private startRandomAct() {
    const cfg = STATE_ACTS[this.state];
    if (!cfg || this.ctx.listening) return;
    const options = cfg.acts.filter((a) => a !== this.lastAct);
    const name = options[Math.floor(Math.random() * options.length)];
    this.lastAct = name;
    this.action = { clip: ACTS[name], start: this.time };
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    let st = t - this.stateStart;
    this.bob = Math.max(0, this.bob - dt * 5);

    // one-shot states move on by themselves when their clip ends
    const next = NEXT[this.state];
    if (next && st >= CLIPS[this.state].clip.len) {
      const ended = this.state;
      this.setState(next);
      this.onStateEnd?.(ended);
    }
    st = t - this.stateStart;
    const key = this.state === 'waiting' && this.ctx.listening ? 'listening' : this.state;
    if (key !== this.baseKey) { this.baseKey = key; this.beginBlend(); this.action = null; }

    // ---- the world around him (hole, flying dirt) moves smoothly every frame
    const wdt = Math.min(0.1, t - this.lastStepTime);
    this.ground.step(wdt, this.state === 'summon' ? t - this.stateStart : null);
    this.paper.step(wdt);
    this.lastStepTime = t;
    // the drawing explodes at the top of the throw
    if (this.state === 'drawToss' && !this.noteGone && t - this.stateStart >= TOSS_EXPLODE_AT) {
      this.noteGone = true;
      this.j.note.updateWorldMatrix(true, false);
      const at = this.root.worldToLocal(this.j.note.getWorldPosition(new THREE.Vector3()));
      this.paper.burst(at, this.inkColors());
      this.j.note.visible = false;
    }

    // ---- stop-motion stepping at 15 fps (User himself)
    const step = Math.floor(t * ANIM_FPS);
    if (step === this.lastStep) return; // hold the frame
    this.lastStep = step;
    const n = step;
    if (this.state !== 'summon') {
      if (hash(n + 0.5) > 0.9) return; // dropped frame
      if (step % 4 !== 0 && hash(Math.floor(step / 4) + 0.77) > 0.82) return; // pose sticks, then snaps ahead
    }

    // ---- acts
    if (this.action && t - this.action.start >= this.action.clip.clip.len) { this.action = null; this.scheduleAct(); }
    if (!this.action && t >= this.nextActAt) this.startRandomAct();

    // ---- sample
    let p: Pose = CLIPS[key].sample(st);
    if (this.action) {
      const at = t - this.action.start;
      const len = this.action.clip.clip.len;
      const w = ease(Math.min(1, at / (this.action.fadeIn ?? 0.2), (len - at) / 0.25));
      p = lerpPose(p, this.action.clip.sample(at), w, this.action.clip.mask);
    }
    const bt = (t - this.blendStart) / 0.3;
    if (bt < 1 && this.state !== 'summon') p = lerpPose(this.from, p, ease(bt));
    this.pose = p;

    // ---- procedural extras: breathing, talk bob, jitter
    const breath = Math.sin(t * 1.7) * (this.state === 'idle' || this.state === 'waiting' ? 0.018 : 0.008);
    const jamt = this.state === 'doing' ? 0.07 : this.state === 'summon' && st < SUMMON_STARE_AT ? 0.12 : 0.045;
    const jit = (k: number) => (hash(n * 7 + k) - 0.5) * jamt;

    const { body, torsoPivot, neck, armL, armR, legL, legR } = this.j;
    body.position.set(p.bodyX * UNIT, p.bodyY * UNIT, p.bodyZ * UNIT); // poses are keyed in model units; body sits in studs
    body.rotation.y = p.bodyTurn;
    torsoPivot.rotation.set(p.torsoX + breath + jit(1), p.torsoY, p.torsoZ + jit(2));
    neck.rotation.set(p.headX + this.bob * 0.14 + jit(3), p.headY + jit(4), p.headZ + jit(5));
    armL.position.y = 180 + p.shoulderY;
    armR.position.y = 180 + p.shoulderY;
    armL.rotation.set(p.armLX + jit(6), p.armLY, p.armLZ - breath * 0.6 + jit(7));
    armR.rotation.set(p.armRX + jit(8), p.armRY, p.armRZ + breath * 0.6 + jit(9));
    legL.rotation.set(p.legLX, 0, p.legLZ);
    legR.rotation.set(p.legRX, 0, p.legRZ);

    // props
    const { note, pen } = this.j;
    note.visible = p.noteOn > 0.5 && !this.noteGone;
    note.position.set(p.noteX, p.noteY, p.noteZ);
    note.rotation.set(p.noteTilt + p.noteSpin, Math.PI + p.noteFlip * Math.PI, p.noteSpin * 0.7);
    pen.visible = p.penOn > 0.5;

    // summon: flicker in and out of existence while climbing out
    // summon: ground breaking open, dirt flying
    const summonT = this.state === 'summon' ? st : null;
    if (summonT !== null) {
      if (summonT < 0.05) this.debrisIdx = 0;
      while (this.debrisIdx < SUMMON_DEBRIS.length && SUMMON_DEBRIS[this.debrisIdx][0] <= summonT) {
        const [, x, count] = SUMMON_DEBRIS[this.debrisIdx++];
        this.ground.burst(x, count);
      }
    }


    // gears turn in jerky ticks while he thinks / works
    if (this.state === 'doing') this.shirt.turn(0.35);
    else if (this.state === 'thinking') this.shirt.turn(0.12);
    else if (this.state === 'summon' && step % 2 === 0) this.shirt.turn(-0.2);
  }
}
