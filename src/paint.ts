// userpaint — User's own little paint program.
//
// The AI doesn't generate an image. It writes the drawing as a list of simple shapes
// (a tiny SVG), and this program *draws* it by hand: every outline is traced with a pen,
// every filled shape is colored in with marker hatching, stroke by stroke, over a few
// seconds, onto a notebook page. Nothing from the SVG is ever put into the page as markup:
// only whitelisted shape geometry and colors are read out of it.

export const PAGE_W = 512;
export const PAGE_H = 384;
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const GEOMETRY_ATTRS = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points'];

type Pt = [number, number];
/** One pen movement: a polyline in page coordinates. Fills are hatch lines clipped to a shape. */
interface Stroke { pts: Pt[]; color: string; width: number; clip?: { path: Path2D; m: DOMMatrix }; len: number }

interface Style { fill: string | null; stroke: string | null; width: number; m: DOMMatrix }

/** Only plain colors (#rgb, #rrggbb, rgb(...), or a simple name) get through. */
function color(v: string | null | undefined, fallback: string | null): string | null {
  if (v == null) return fallback;
  const t = v.trim().toLowerCase();
  if (t === 'none' || t === 'transparent') return null;
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(t)) return t;
  if (/^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\)$/.test(t)) return t;
  if (/^[a-z]{3,20}$/.test(t)) return t;
  return fallback;
}

export class Painter {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private si = 0; // current stroke
  private pi = 0; // progress (in pixels of ink) inside the current stroke
  private speed = 600; // px of ink per second
  /** true while there is still ink to put down */
  drawing = false;
  /** set whenever the canvas changed (the 3D notebook texture re-uploads) */
  dirty = false;
  private svgHost: SVGSVGElement;

  constructor(private scale = 1) {
    this.canvas.width = PAGE_W * scale;
    this.canvas.height = PAGE_H * scale;
    this.ctx = this.canvas.getContext('2d')!;
    // a hidden <svg> used only to measure path lengths / sample points
    this.svgHost = document.createElementNS(SVG_NS, 'svg');
    this.svgHost.setAttribute('width', '0');
    this.svgHost.setAttribute('height', '0');
    this.svgHost.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden';
    document.body.appendChild(this.svgHost);
    this.clear();
  }

  /** A blank notebook page: off-white paper, faint blue rules and a red margin. */
  clear(): void {
    const g = this.ctx;
    const s = this.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#f4f1e8';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.strokeStyle = 'rgba(80, 120, 200, 0.18)';
    g.lineWidth = 1 * s;
    for (let y = 30; y < PAGE_H; y += 22) { g.beginPath(); g.moveTo(0, y * s); g.lineTo(PAGE_W * s, y * s); g.stroke(); }
    g.strokeStyle = 'rgba(210, 60, 60, 0.22)';
    g.beginPath(); g.moveTo(36 * s, 0); g.lineTo(36 * s, PAGE_H * s); g.stroke();
    this.dirty = true;
  }

  /** Read the AI's SVG into pen strokes. Returns how many shapes it found. */
  load(svgText: string, durationSec = 11): number {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('unreadable drawing');
    // map the drawing's viewBox onto the page
    const vb = (root.getAttribute('viewBox') || `0 0 ${PAGE_W} ${PAGE_H}`).split(/[\s,]+/).map(Number);
    const [vx, vy, vw, vh] = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0 ? vb : [0, 0, PAGE_W, PAGE_H];
    const k = Math.min(PAGE_W / vw, PAGE_H / vh);
    const base = new DOMMatrix().translate((PAGE_W - vw * k) / 2, (PAGE_H - vh * k) / 2).scale(k).translate(-vx, -vy);

    this.strokes = [];
    this.walk(root, { fill: '#000000', stroke: null, width: 3, m: base }, 0);
    this.clear();
    this.si = 0;
    this.pi = 0;
    const ink = this.strokes.reduce((a, s) => a + s.len, 0);
    this.speed = Math.max(250, ink / durationSec);
    this.drawing = this.strokes.length > 0;
    return this.strokes.length;
  }

  private walk(el: Element, inherited: Style, depth: number) {
    if (depth > 12) return;
    for (const child of Array.from(el.children)) {
      const tag = child.nodeName.toLowerCase();
      if (tag !== 'g' && !SHAPES.has(tag)) continue; // everything else is ignored
      const m = inherited.m.multiply(this.transformOf(child));
      const st: Style = {
        fill: color(child.getAttribute('fill'), inherited.fill),
        stroke: color(child.getAttribute('stroke'), inherited.stroke),
        width: Math.min(14, Math.max(0.5, Number(child.getAttribute('stroke-width')) || inherited.width)),
        m,
      };
      if (tag === 'g') this.walk(child, st, depth + 1);
      else this.addShape(tag, child, st);
      if (this.strokes.length > 4000) return;
    }
  }

  private transformOf(el: Element): DOMMatrix {
    const t = el.getAttribute('transform');
    if (!t) return new DOMMatrix();
    const probe = document.createElementNS(SVG_NS, 'g');
    probe.setAttribute('transform', t.slice(0, 300));
    const c = probe.transform.baseVal.consolidate();
    return c ? DOMMatrix.fromMatrix(c.matrix) : new DOMMatrix();
  }

  private addShape(tag: string, src: Element, st: Style) {
    // rebuild the shape from whitelisted geometry only
    const el = document.createElementNS(SVG_NS, tag) as SVGGeometryElement;
    for (const a of GEOMETRY_ATTRS) {
      const v = src.getAttribute(a);
      if (v != null) el.setAttribute(a, v.slice(0, 20000));
    }
    this.svgHost.appendChild(el);
    try {
      const path = this.path2d(tag, el);
      const outline = this.sample(el, st.m);
      if (outline.length < 2 || !path) return;
      // colour it in first (marker hatching), then trace the outline on top.
      // (like SVG itself, open paths and polylines get filled too; a bare <line> can't be)
      if (st.fill && tag !== 'line') this.hatch(outline, path, st.m, st.fill);
      if (st.stroke) this.strokes.push({ pts: outline, color: st.stroke, width: st.width * this.mScale(st.m), len: length(outline) });
    } catch {
      /* a malformed shape is just skipped */
    } finally {
      el.remove();
    }
  }

  private mScale(m: DOMMatrix) { return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1; }

  private path2d(tag: string, el: SVGGeometryElement): Path2D | null {
    const n = (a: string) => Number(el.getAttribute(a)) || 0;
    const p = new Path2D();
    switch (tag) {
      case 'path': return new Path2D(el.getAttribute('d') ?? '');
      case 'circle': p.arc(n('cx'), n('cy'), Math.abs(n('r')), 0, Math.PI * 2); return p;
      case 'ellipse': p.ellipse(n('cx'), n('cy'), Math.abs(n('rx')), Math.abs(n('ry')), 0, 0, Math.PI * 2); return p;
      case 'rect': p.rect(n('x'), n('y'), n('width'), n('height')); return p;
      case 'polygon': case 'polyline': case 'line': {
        const pts = tag === 'line'
          ? [[n('x1'), n('y1')], [n('x2'), n('y2')]]
          : (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number).reduce<number[][]>((a, v, i) => { if (i % 2) a[a.length - 1].push(v); else a.push([v]); return a; }, []);
        pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
        if (tag === 'polygon') p.closePath();
        return p;
      }
      default: return null;
    }
  }

  /** Walk along the shape's outline and collect points on the page every ~2 px. */
  private sample(el: SVGGeometryElement, m: DOMMatrix): Pt[] {
    let total = 0;
    try { total = el.getTotalLength(); } catch { return []; }
    if (!Number.isFinite(total) || total <= 0) return [];
    const k = this.mScale(m);
    const n = Math.min(1500, Math.max(2, Math.ceil((total * k) / 2)));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const q = el.getPointAtLength((total * i) / n);
      const t = m.transformPoint(new DOMPoint(q.x, q.y));
      pts.push([t.x, t.y]);
    }
    return pts;
  }

  /** Colour a shape in like a marker: diagonal back-and-forth lines, clipped to the shape. */
  private hatch(outline: Pt[], path: Path2D, m: DOMMatrix, fill: string) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of outline) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (!Number.isFinite(x0) || x1 - x0 < 1 || y1 - y0 < 1) return;
    const gap = 3.2;
    const pts: Pt[] = [];
    // 45° zig-zag covering the bounding box; the clip keeps it inside the shape
    let flip = false;
    for (let c = x0 - (y1 - y0); c <= x1; c += gap) {
      const a: Pt = [c, y1], b: Pt = [c + (y1 - y0), y0];
      if (flip) pts.push(b, a); else pts.push(a, b);
      flip = !flip;
    }
    if (pts.length < 2) return;
    this.strokes.push({ pts, color: fill, width: gap * 1.7, clip: { path, m }, len: length(pts) });
  }

  /** Put down the next bit of ink. Call every frame; it's cheap when there's nothing to do. */
  update(dt: number): void {
    if (!this.drawing) return;
    let budget = this.speed * Math.min(dt, 0.1);
    const g = this.ctx;
    const s = this.scale;
    while (budget > 0 && this.si < this.strokes.length) {
      const st = this.strokes[this.si];
      const remaining = st.len - this.pi;
      // spend exactly `step` of the budget, so float rounding can never leave a budget
      // that's too small to move the pen (which would loop forever)
      const step = Math.min(budget, remaining);
      budget -= step;
      const from = this.pi;
      const to = from + step;
      g.save();
      if (st.clip) {
        g.setTransform(s * st.clip.m.a, s * st.clip.m.b, s * st.clip.m.c, s * st.clip.m.d, s * st.clip.m.e, s * st.clip.m.f);
        g.clip(st.clip.path);
      }
      g.setTransform(s, 0, 0, s, 0, 0);
      g.strokeStyle = st.color;
      g.globalAlpha = st.clip ? 0.9 : 1;
      g.lineWidth = st.width;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      drawRange(g, st.pts, from, to, this.si);
      g.restore();
      this.pi = to;
      if (step >= remaining - 1e-6) { this.si++; this.pi = 0; }
    }
    this.dirty = true;
    if (this.si >= this.strokes.length) this.drawing = false;
  }

  /** Finish instantly (used for the sharp copy in the pop-up window). */
  finish(): void {
    if (!this.drawing) return;
    this.update(1e9);
    while (this.drawing) this.update(1e9);
  }

  /** A sharper copy of the same drawing (rendered at `scale`x). */
  copyAt(scale: number): HTMLCanvasElement {
    const p = new Painter(scale);
    p.strokes = this.strokes;
    p.speed = 1e12;
    p.drawing = this.strokes.length > 0;
    p.finish();
    p.svgHost.remove();
    return p.canvas;
  }

  /** Random ink colours from the drawing (for the paper scraps when it explodes). */
  sampleColors(n: number): string[] {
    const out: string[] = [];
    const d = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    for (let i = 0; i < n; i++) {
      const x = Math.floor(Math.random() * this.canvas.width), y = Math.floor(Math.random() * this.canvas.height);
      const o = (y * this.canvas.width + x) * 4;
      out.push(`rgb(${d[o]},${d[o + 1]},${d[o + 2]})`);
    }
    return out;
  }
}

function length(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Draw the part of a polyline between two distances along it, with a slight hand wobble. */
function drawRange(g: CanvasRenderingContext2D, pts: Pt[], from: number, to: number, seed: number) {
  let acc = 0;
  let started = false;
  g.beginPath();
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const seg = Math.hypot(bx - ax, by - ay);
    const s0 = acc, s1 = acc + seg;
    acc = s1;
    if (s1 < from) continue;
    if (s0 > to) break;
    const wob = (d: number) => Math.sin(d * 0.045 + seed * 1.7) * 0.6 + Math.sin(d * 0.13 + seed) * 0.25;
    const t0 = seg ? Math.max(0, (from - s0) / seg) : 0;
    const t1 = seg ? Math.min(1, (to - s0) / seg) : 1;
    const px = ax + (bx - ax) * t0, py = ay + (by - ay) * t0;
    if (!started) { g.moveTo(px + wob(s0), py + wob(s0 + 50)); started = true; }
    g.lineTo(ax + (bx - ax) * t1 + wob(s1), ay + (by - ay) * t1 + wob(s1 + 50));
  }
  g.stroke();
}
