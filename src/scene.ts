// The world: Glass Houses at night, a camera that stares at User, and a VHS filter.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Character } from './character';

/**
 * The OBJ map is ~2,500 separate parts. Drawing them one by one costs ~2,500 draw calls a
 * frame, which stutters on weak GPUs. Bake them into one mesh per material instead (~30).
 */
function mergeByMaterial(src: THREE.Group): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.MeshPhongMaterial; geos: THREE.BufferGeometry[] }>();
  src.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry as THREE.BufferGeometry).index ? (o.geometry as THREE.BufferGeometry).toNonIndexed() : (o.geometry as THREE.BufferGeometry);
    const mats = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshPhongMaterial[];
    const total = geo.attributes.position.count;
    const ranges = geo.groups.length ? geo.groups : [{ start: 0, count: total, materialIndex: 0 }];
    for (const r of ranges) {
      const mat = mats[r.materialIndex ?? 0] ?? mats[0];
      const count = Math.min(r.count, total - r.start);
      if (count <= 0) continue;
      const part = new THREE.BufferGeometry();
      const slice = (name: string) => {
        const a = geo.getAttribute(name) as THREE.BufferAttribute | undefined;
        if (!a) return null;
        return new THREE.BufferAttribute((a.array as Float32Array).slice(r.start * a.itemSize, (r.start + count) * a.itemSize), a.itemSize);
      };
      part.setAttribute('position', slice('position')!);
      const normal = slice('normal');
      if (normal) part.setAttribute('normal', normal); else part.computeVertexNormals();
      // every geometry in a merge needs the same attributes: uv only where there's a texture
      if (mat.map) part.setAttribute('uv', slice('uv') ?? new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      part.applyMatrix4(o.matrixWorld);
      const key = mat.name || mat.uuid;
      if (!buckets.has(key)) buckets.set(key, { mat, geos: [] });
      buckets.get(key)!.geos.push(part);
    }
  });
  const out = new THREE.Group();
  for (const { mat, geos } of buckets.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const transparent = mat.transparent || mat.opacity < 1;
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({
      color: mat.color, map: mat.map ?? null, transparent, opacity: mat.opacity,
      side: THREE.DoubleSide, depthWrite: !transparent,
    }));
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    out.add(mesh);
  }
  return out;
}

// Where User stands: out on the grass of Glass Houses, the houses glowing behind him (studs).
export const SPOT = new THREE.Vector3(-3.7, 84, -201);
export const CAMERA_DIR = new THREE.Vector3(-0.5, 0, 0.85).normalize(); // direction from User to the camera
const CAMERA_DIST = 11.5;
const CAMERA_HEIGHT = 3.4;
const LOOK_HEIGHT = 2.6;

const VHSShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    glitch: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float time; uniform float glitch; uniform vec2 resolution;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      // slight barrel distortion, like an old CRT capture
      vec2 cc = uv - 0.5; float d = dot(cc, cc);
      uv = 0.5 + cc * (1.0 + 0.06 * d);
      // tracking wobble + a rolling band, stronger while glitching
      float band = smoothstep(0.0, 0.04, abs(fract(uv.y * 0.6 - time * 0.08) - 0.5) - 0.44);
      float wob = sin(uv.y * 240.0 + time * 9.0) * 0.0006 + (1.0 - band) * 0.004;
      float tear = step(0.985 - glitch * 0.25, rand(vec2(floor(uv.y * 48.0), floor(time * 14.0))));
      uv.x += wob + tear * (rand(vec2(time, uv.y)) - 0.5) * (0.02 + glitch * 0.08);
      // chromatic aberration
      float ca = 0.0018 + glitch * 0.006;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + vec2(ca, 0.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - vec2(ca, 0.0)).b;
      // scanlines, crushed colour and vignette
      col *= 0.86 + 0.14 * sin(vUv.y * resolution.y * 1.6);
      col = mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))), 0.12);
      col *= 1.0 - (1.0 - band) * 0.08;
      col *= smoothstep(0.95, 0.25, length(vUv - 0.5) * 1.15);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

function makeSky(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#000003');
  grad.addColorStop(0.55, '#020628');
  grad.addColorStop(1, '#06104a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 900; i++) {
    const y = Math.random() ** 1.6 * 300;
    g.fillStyle = `rgba(${170 + Math.random() * 80},${180 + Math.random() * 70},255,${Math.random() * 0.8})`;
    g.fillRect(Math.random() * 1024, y, Math.random() < 0.1 ? 2 : 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMoon(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
  grad.addColorStop(0, 'rgba(220,230,255,1)');
  grad.addColorStop(0.32, 'rgba(190,205,255,0.95)');
  grad.addColorStop(0.36, 'rgba(90,110,255,0.25)');
  grad.addColorStop(1, 'rgba(0,0,80,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, depthWrite: false }));
  s.scale.setScalar(60);
  return s;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 900);
  readonly ambient = new THREE.AmbientLight(0x0b1fb8, 5.0); // night: a strong, dark-blue ambience
  glitch = 0;
  mapDrawCalls = 0;
  spot = SPOT.clone();
  private camDir = CAMERA_DIR.clone();
  private camBase = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private moon = new THREE.DirectionalLight(0x8fa4ff, 0.75);
  private faceLight = new THREE.PointLight(0x5068ff, 12, 22, 1.3);
  private moonSprite: THREE.Sprite | null = null;
  private composer: EffectComposer;
  private vhs: ShaderPass;
  private shakeStep = -1;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false; // count every pass of a frame (F3 counter)
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = makeSky();
    this.scene.fog = new THREE.FogExp2(0x010418, 0.011);
    this.scene.add(this.ambient);
    this.scene.add(new THREE.HemisphereLight(0x2236ff, 0x000010, 1.4));
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(1024, 1024);
    Object.assign(this.moon.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 200 });
    this.moon.shadow.bias = -0.0008;
    this.scene.add(this.moon, this.moon.target);
    // a cold light from where the camera is, so his face reads in the dark
    this.scene.add(this.faceLight);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.vhs = new ShaderPass(VHSShader);
    this.composer.addPass(this.vhs);
    this.composer.addPass(new OutputPass());

    this.setSpot(this.spot);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setSpot(spot: THREE.Vector3, camDir: THREE.Vector3 = this.camDir): void {
    this.spot = spot.clone();
    this.camDir = camDir.clone().normalize();
    this.camBase.copy(spot).addScaledVector(this.camDir, CAMERA_DIST).add(new THREE.Vector3(0, CAMERA_HEIGHT, 0));
    this.lookAt.copy(spot).add(new THREE.Vector3(0, LOOK_HEIGHT, 0));
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.lookAt);
    this.moon.position.copy(spot).add(new THREE.Vector3(-40, 70, -30));
    this.moon.target.position.copy(spot);
    this.faceLight.position.copy(spot).addScaledVector(this.camDir, 4).add(new THREE.Vector3(0, 4.2, 0));
    this.moonSprite?.position.copy(spot).add(new THREE.Vector3(-160, 140, -380));
  }

  async loadMap(dir: string, mtl: string, obj: string, onProgress?: (e: ProgressEvent) => void): Promise<THREE.Group> {
    const materials = await new MTLLoader().setPath(dir).loadAsync(mtl);
    materials.preload();
    const loader = new OBJLoader().setMaterials(materials);
    const raw = await new Promise<THREE.Group>((res, rej) => loader.load(dir + obj, res, onProgress, rej));
    const group = mergeByMaterial(raw);
    this.mapDrawCalls = group.children.length;
    this.scene.add(group);
    this.moonSprite = makeMoon();
    this.scene.add(this.moonSprite);
    // stand exactly on whatever surface is under the chosen spot
    const ray = new THREE.Raycaster(this.spot.clone().add(new THREE.Vector3(0, 4, 0)), new THREE.Vector3(0, -1, 0), 0, 30);
    const hit = ray.intersectObject(group, true)[0];
    if (hit) this.spot.y = hit.point.y;
    this.setSpot(this.spot);
    return group;
  }

  addCharacter(character: Character): void {
    character.root.position.copy(this.spot);
    // face the camera, straight on
    const toCam = this.camBase.clone().sub(this.spot);
    character.root.rotation.y = Math.atan2(toCam.x, toCam.z);
    this.scene.add(character.root);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    // render at a low resolution on purpose: it should look like a bad recording
    const pr = Math.min(window.devicePixelRatio || 1, 1) * 0.62;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.vhs.uniforms.resolution.value.set(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(time: number): void {
    // handheld camera that only moves in little jumps
    const step = Math.floor(time * 4);
    if (step !== this.shakeStep) {
      this.shakeStep = step;
      const r = (k: number) => (Math.sin(step * 12.9898 + k * 78.233) * 43758.5453) % 1;
      this.camera.position.copy(this.camBase).add(new THREE.Vector3(r(1) * 0.05, r(2) * 0.05, r(3) * 0.03));
      this.camera.lookAt(this.lookAt);
    }
    this.renderer.info.reset();
    this.vhs.uniforms.time.value = time;
    this.vhs.uniforms.glitch.value = this.glitch;
    this.composer.render();
  }
}
