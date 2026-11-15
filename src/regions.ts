// Авто-области эскиза: пересекающиеся контуры и линии делят плоскость на замкнутые области,
// каждую из которых можно выбрать и вытянуть отдельно.
// Кривые (отрезки, дуги, эллипсы) для поиска пересечений дробятся на короткие хорды,
// но точки пересечения уточняются по точной геометрии, а граница области собирается
// снова из точных отрезков и дуг — ядро строит тело без граней-«ступенек».
import { dist2, rectCorners, type Profile, type RSeg, type V2 } from "./sketch";

type Curve =
  | { k: "line"; a: V2; b: V2 }
  /** Дуга окружности: от угла a0 на угол sw (со знаком), радианы */
  | { k: "arc"; c: V2; r: number; a0: number; sw: number }
  /** Дуга эллипса с осями вдоль X/Y: параметр t от t0 на sw */
  | { k: "ell"; c: V2; rx: number; ry: number; t0: number; sw: number };

export interface RegionLoop {
  segs: RSeg[];
  /** Ломаная для отображения и проверок */
  pts: V2[];
}

export interface Region {
  outer: RegionLoop;
  holes: RegionLoop[];
  area: number;
  /** Область совпадает с целым профилем — выбирается как сам профиль */
  profile?: number;
}

const TAU = Math.PI * 2;
const MERGE = 1e-3; // мм — точки ближе считаются одной вершиной

function curveAt(cv: Curve, s: number): V2 {
  if (cv.k === "line") return [cv.a[0] + (cv.b[0] - cv.a[0]) * s, cv.a[1] + (cv.b[1] - cv.a[1]) * s];
  if (cv.k === "arc") {
    const a = cv.a0 + cv.sw * s;
    return [cv.c[0] + cv.r * Math.cos(a), cv.c[1] + cv.r * Math.sin(a)];
  }
  const t = cv.t0 + cv.sw * s;
  return [cv.c[0] + cv.rx * Math.cos(t), cv.c[1] + cv.ry * Math.sin(t)];
}

const pieceCount = (cv: Curve) =>
  cv.k === "line" ? 1 : cv.k === "arc" ? Math.max(2, Math.ceil((Math.abs(cv.sw) / TAU) * 96)) : Math.max(4, Math.ceil((Math.abs(cv.sw) / TAU) * 128));

/** Углы многоугольника со скруглениями — те же, что рисует эскиз, но точными дугами */
function cornerCurves(pts: V2[], radii?: number[]): Curve[] {
  const n = pts.length;
  const corner = pts.map((v, i) => {
    const r0 = radii?.[i] ?? 0;
    if (!(r0 > 0)) return { t1: v, t2: v, arc: null as Curve | null };
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const l1 = dist2(prev, v) || 1;
    const l2 = dist2(next, v) || 1;
    const u1: V2 = [(prev[0] - v[0]) / l1, (prev[1] - v[1]) / l1];
    const u2: V2 = [(next[0] - v[0]) / l2, (next[1] - v[1]) / l2];
    const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (theta < 1e-3 || theta > Math.PI - 1e-3) return { t1: v, t2: v, arc: null };
    let t = r0 / Math.tan(theta / 2);
    t = Math.min(t, l1 / 2, l2 / 2);
    const r = t * Math.tan(theta / 2);
    const t1: V2 = [v[0] + u1[0] * t, v[1] + u1[1] * t];
    const t2: V2 = [v[0] + u2[0] * t, v[1] + u2[1] * t];
    const bis: V2 = [u1[0] + u2[0], u1[1] + u2[1]];
    const bl = Math.hypot(...bis) || 1;
    const k = r / Math.sin(theta / 2) / bl;
    const c: V2 = [v[0] + bis[0] * k, v[1] + bis[1] * k];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    let sw = Math.atan2(t2[1] - c[1], t2[0] - c[0]) - a0;
    while (sw > Math.PI) sw -= TAU;
    while (sw < -Math.PI) sw += TAU;
    return { t1, t2, arc: { k: "arc", c, r, a0, sw } as Curve };
  });
  const out: Curve[] = [];
  corner.forEach((cr, i) => {
    if (cr.arc) out.push(cr.arc);
    const nx = corner[(i + 1) % n];
    if (dist2(cr.t2, nx.t1) > 1e-9) out.push({ k: "line", a: cr.t2, b: nx.t1 });
  });
  return out;
}

function profileCurves(p: Profile): Curve[] {
  switch (p.kind) {
    case "rect":
      return cornerCurves(rectCorners(p), p.radii);
    case "poly":
      return cornerCurves(p.pts, p.radii);
    case "circle":
      return p.r > 0 ? [{ k: "arc", c: [p.cx, p.cy], r: p.r, a0: 0, sw: TAU }] : [];
    case "ellipse":
      return p.rx > 0 && p.ry > 0 ? [{ k: "ell", c: [p.cx, p.cy], rx: p.rx, ry: p.ry, t0: 0, sw: TAU }] : [];
    case "slot": {
      const len = dist2(p.a, p.b);
      if (len < 1e-9 || !(p.r > 0)) return [];
      const ang = Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]);
      const n: V2 = [-Math.sin(ang) * p.r, Math.cos(ang) * p.r];
      return [
        { k: "line", a: [p.a[0] + n[0], p.a[1] + n[1]], b: [p.b[0] + n[0], p.b[1] + n[1]] },
        { k: "arc", c: p.b, r: p.r, a0: ang + Math.PI / 2, sw: -Math.PI },
        { k: "line", a: [p.b[0] - n[0], p.b[1] - n[1]], b: [p.a[0] - n[0], p.a[1] - n[1]] },
        { k: "arc", c: p.a, r: p.r, a0: ang - Math.PI / 2, sw: -Math.PI },
      ];
    }
    case "path":
      return p.pts.slice(0, -1).map((a, j) => ({ k: "line", a, b: p.pts[j + 1] }) as Curve);
    default:
      return [];
  }
}

// ---------- точное уточнение пересечений ----------

function lineCircle(a: V2, b: V2, c: V2, r: number): V2[] {
  const d: V2 = [b[0] - a[0], b[1] - a[1]];
  const f: V2 = [a[0] - c[0], a[1] - c[1]];
  const A = d[0] * d[0] + d[1] * d[1];
  const B = 2 * (f[0] * d[0] + f[1] * d[1]);
  const C = f[0] * f[0] + f[1] * f[1] - r * r;
  const disc = B * B - 4 * A * C;
  if (A < 1e-18 || disc < -1e-9) return [];
  const s = Math.sqrt(Math.max(0, disc));
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].map((t) => [a[0] + d[0] * t, a[1] + d[1] * t] as V2);
}

function circleCircle(c1: V2, r1: number, c2: V2, r2: number): V2[] {
  const d = dist2(c1, c2);
  if (d < 1e-12 || d > r1 + r2 + 1e-7 || d < Math.abs(r1 - r2) - 1e-7) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m: V2 = [c1[0] + ((c2[0] - c1[0]) * a) / d, c1[1] + ((c2[1] - c1[1]) * a) / d];
  const o: V2 = [(-(c2[1] - c1[1]) * h) / d, ((c2[0] - c1[0]) * h) / d];
  return [
    [m[0] + o[0], m[1] + o[1]],
    [m[0] - o[0], m[1] - o[1]],
  ];
}

/** Приблизительная точка пересечения хорд → точная точка пересечения кривых */
function refine(x: V2, c1: Curve, c2: Curve): V2 {
  if (c1 === c2 || c1.k === "ell" || c2.k === "ell" || (c1.k === "line" && c2.k === "line")) return x;
  let cands: V2[];
  if (c1.k === "arc" && c2.k === "arc") cands = circleCircle(c1.c, c1.r, c2.c, c2.r);
  else {
    const l = (c1.k === "line" ? c1 : c2) as Extract<Curve, { k: "line" }>;
    const a = (c1.k === "arc" ? c1 : c2) as Extract<Curve, { k: "arc" }>;
    cands = lineCircle(l.a, l.b, a.c, a.r);
  }
  let best = x;
  let bd = 0.5;
  for (const q of cands) {
    const dd = dist2(q, x);
    if (dd < bd) [best, bd] = [q, dd];
  }
  return best;
}

// ---------- разбиение плоскости ----------

interface Piece {
  a: V2;
  b: V2;
  ci: number;
  /** Точки разбиения (включая концы) */
  cuts: V2[];
}

const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];

function signedArea(pts: V2[]) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function pointInPoly(q: V2, pts: V2[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const cache = new WeakMap<Profile[], Region[]>();

/** Области эскиза. Пустой список — нет замкнутых контуров */
export function sketchRegions(profiles: Profile[]): Region[] {
  let r = cache.get(profiles);
  if (!r) {
    try {
      r = compute(profiles);
    } catch (err) {
      console.error("regions", err);
      r = [];
    }
    cache.set(profiles, r);
  }
  return r;
}

function compute(profiles: Profile[]): Region[] {
  const curves: Curve[] = [];
  const owner: number[] = [];
  profiles.forEach((p, i) =>
    profileCurves(p).forEach((c) => {
      curves.push(c);
      owner.push(i);
    }),
  );
  if (!curves.length) return [];

  // 1. Хорды
  const pieces: Piece[] = [];
  const piecesOf = new Map<number, number>(); // профиль → число хорд
  curves.forEach((cv, ci) => {
    const n = pieceCount(cv);
    let prev = curveAt(cv, 0);
    for (let j = 1; j <= n; j++) {
      const q = j === n && (cv.k !== "line" && Math.abs(cv.sw) >= TAU - 1e-9) ? curveAt(cv, 0) : curveAt(cv, j / n);
      pieces.push({ a: prev, b: q, ci, cuts: [prev, q] });
      prev = q;
    }
    piecesOf.set(owner[ci], (piecesOf.get(owner[ci]) ?? 0) + n);
  });

  // 2. Пересечения хорд (с допуском), точки уточняются по точной геометрии
  const box = pieces.map((p) => [Math.min(p.a[0], p.b[0]), Math.min(p.a[1], p.b[1]), Math.max(p.a[0], p.b[0]), Math.max(p.a[1], p.b[1])]);
  const E = 1e-9;
  for (let i = 0; i < pieces.length; i++) {
    const P = pieces[i];
    const bi = box[i];
    for (let j = i + 1; j < pieces.length; j++) {
      const bj = box[j];
      if (bj[0] > bi[2] + 1e-6 || bj[2] < bi[0] - 1e-6 || bj[1] > bi[3] + 1e-6 || bj[3] < bi[1] - 1e-6) continue;
      const Q = pieces[j];
      if (P.ci === Q.ci) continue; // хорды одной кривой стыкуются только концами
      const r: V2 = [P.b[0] - P.a[0], P.b[1] - P.a[1]];
      const s: V2 = [Q.b[0] - Q.a[0], Q.b[1] - Q.a[1]];
      const den = cross(r, s);
      const qa: V2 = [Q.a[0] - P.a[0], Q.a[1] - P.a[1]];
      const lr = Math.hypot(...r);
      const ls = Math.hypot(...s);
      if (Math.abs(den) < 1e-10 * lr * ls) {
        // Параллельные: если на одной прямой — концы каждой режут другую
        if (Math.abs(cross(r, qa)) / (lr || 1) > 1e-6) continue;
        for (const q of [Q.a, Q.b]) {
          const t = ((q[0] - P.a[0]) * r[0] + (q[1] - P.a[1]) * r[1]) / (lr * lr || 1);
          if (t > E && t < 1 - E) P.cuts.push(q);
        }
        for (const q of [P.a, P.b]) {
          const t = ((q[0] - Q.a[0]) * s[0] + (q[1] - Q.a[1]) * s[1]) / (ls * ls || 1);
          if (t > E && t < 1 - E) Q.cuts.push(q);
        }
        continue;
      }
      const t = cross(qa, s) / den;
      const u = cross(qa, r) / den;
      const tol = 1e-7;
      if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) continue;
      const x = refine([P.a[0] + r[0] * t, P.a[1] + r[1] * t], curves[P.ci], curves[Q.ci]);
      P.cuts.push(x);
      Q.cuts.push(x);
    }
  }

  // 3. Концы открытых кривых, лежащие на чужой кривой (привязка к дуге по хордам эскиза
  //    даёт точку чуть внутри/снаружи окружности — допуск зависит от радиуса)
  const ends: { p: V2; ci: number }[] = [];
  curves.forEach((cv, ci) => {
    if (cv.k !== "line" && Math.abs(cv.sw) >= TAU - 1e-9) return;
    ends.push({ p: curveAt(cv, 0), ci }, { p: curveAt(cv, 1), ci });
  });
  for (const e of ends) {
    for (const P of pieces) {
      if (P.ci === e.ci) continue;
      const cv = curves[P.ci];
      const tol = 0.02 + (cv.k === "arc" ? cv.r * 0.0012 : cv.k === "ell" ? Math.max(cv.rx, cv.ry) * 0.0012 : 0);
      const r: V2 = [P.b[0] - P.a[0], P.b[1] - P.a[1]];
      const l2 = r[0] * r[0] + r[1] * r[1] || 1;
      const t = ((e.p[0] - P.a[0]) * r[0] + (e.p[1] - P.a[1]) * r[1]) / l2;
      if (t < 0 || t > 1) continue;
      const f: V2 = [P.a[0] + r[0] * t, P.a[1] + r[1] * t];
      if (dist2(f, e.p) < tol) P.cuts.push(e.p);
    }
  }

  // 4. Вершины и рёбра
  const verts: V2[] = [];
  const grid = new Map<string, number[]>();
  const vid = (q: V2) => {
    const gx = Math.round(q[0] / MERGE);
    const gy = Math.round(q[1] / MERGE);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const k of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (dist2(verts[k], q) < MERGE) return k;
    verts.push(q);
    const key = `${gx},${gy}`;
    grid.set(key, [...(grid.get(key) ?? []), verts.length - 1]);
    return verts.length - 1;
  };
  const edges: { u: number; v: number; ci: number }[] = [];
  const seen = new Set<string>();
  for (const P of pieces) {
    const r: V2 = [P.b[0] - P.a[0], P.b[1] - P.a[1]];
    const ids = P.cuts
      .map((q) => ({ q, t: (q[0] - P.a[0]) * r[0] + (q[1] - P.a[1]) * r[1] }))
      .sort((x, y) => x.t - y.t)
      .map((x) => vid(x.q));
    for (let k = 0; k + 1 < ids.length; k++) {
      const [u, v] = [ids[k], ids[k + 1]];
      if (u === v) continue;
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ u, v, ci: P.ci });
    }
  }

  // 5. Висячие рёбра (линии, не замыкающие область) убираем
  let alive = edges.map(() => true);
  for (;;) {
    const deg = new Array(verts.length).fill(0);
    edges.forEach((e, k) => alive[k] && (deg[e.u]++, deg[e.v]++));
    let removed = false;
    edges.forEach((e, k) => {
      if (alive[k] && (deg[e.u] < 2 || deg[e.v] < 2)) {
        alive[k] = false;
        removed = true;
      }
    });
    if (!removed) break;
  }
  const live = edges.filter((_, k) => alive[k]);
  alive = [];
  if (!live.length) return [];

  // 6. Полурёбра: 2k — u→v, 2k+1 — v→u; обход граней «самым левым поворотом»
  const from = (h: number) => (h & 1 ? live[h >> 1].v : live[h >> 1].u);
  const to = (h: number) => (h & 1 ? live[h >> 1].u : live[h >> 1].v);
  const out = new Map<number, number[]>();
  for (let h = 0; h < live.length * 2; h++) out.set(from(h), [...(out.get(from(h)) ?? []), h]);
  const angle = (h: number) => {
    const a = verts[from(h)];
    const b = verts[to(h)];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const pos = new Map<number, number>();
  for (const list of out.values()) {
    list.sort((x, y) => angle(x) - angle(y));
    list.forEach((h, i) => pos.set(h, i));
  }
  const next = (h: number) => {
    const list = out.get(to(h))!;
    const i = pos.get(h ^ 1)!;
    return list[(i - 1 + list.length) % list.length];
  };
  const used = new Uint8Array(live.length * 2);
  const faces: { hs: number[]; pts: V2[]; area: number }[] = [];
  for (let h0 = 0; h0 < live.length * 2; h0++) {
    if (used[h0]) continue;
    const hs: number[] = [];
    let h = h0;
    let guard = 0;
    while (!used[h] && guard++ < 100000) {
      used[h] = 1;
      hs.push(h);
      h = next(h);
    }
    const pts = hs.map((x) => verts[from(x)]);
    faces.push({ hs, pts, area: signedArea(pts) });
  }

  // 7. Связные компоненты — для вложенных контуров (отверстий)
  const parent = verts.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of live) parent[find(e.u)] = find(e.v);
  const bounded = faces.filter((f) => f.area > 1e-6);
  const outers = faces.filter((f) => f.area < -1e-6);
  const holesOf = new Map<(typeof faces)[number], (typeof faces)[number][]>();
  for (const o of outers) {
    const comp = find(from(o.hs[0]));
    const probe = o.pts[0];
    let best: (typeof faces)[number] | null = null;
    for (const f of bounded) {
      if (find(from(f.hs[0])) === comp) continue;
      if ((!best || f.area < best.area) && pointInPoly(probe, f.pts)) best = f;
    }
    if (best) holesOf.set(best, [...(holesOf.get(best) ?? []), o]);
  }

  const ciOf = (h: number) => live[h >> 1].ci;
  return bounded
    .map((f): Region => {
      const holes = holesOf.get(f) ?? [];
      const region: Region = {
        outer: toLoop(f.hs, from, ciOf, verts, curves),
        holes: holes.map((o) => toLoop(o.hs, from, ciOf, verts, curves)),
        area: f.area - holes.reduce((s, o) => s - o.area, 0),
      };
      // Целый профиль без пересечений: все рёбра его, ни одна хорда не разрезана
      const prof = owner[ciOf(f.hs[0])];
      if (!holes.length && f.hs.every((h) => owner[ciOf(h)] === prof) && f.hs.length === piecesOf.get(prof)) region.profile = prof;
      return region;
    })
    .sort((a, b) => (a.profile ?? 1e9) - (b.profile ?? 1e9));
}

/** Замкнутый обход → точные отрезки/дуги (соседние хорды одной кривой — один участок) */
function toLoop(hs: number[], from: (h: number) => number, ciOf: (h: number) => number, verts: V2[], curves: Curve[]): RegionLoop {
  const n = hs.length;
  const pts = hs.map((h) => verts[from(h)]);
  let start = hs.findIndex((h, i) => ciOf(h) !== ciOf(hs[(i - 1 + n) % n]));
  const single = start < 0;
  if (single) start = 0;
  const runs: { ci: number; pts: V2[] }[] = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const ci = ciOf(hs[i]);
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const last = runs[runs.length - 1];
    // Целая окружность одной кривой — делим пополам: дуга в 360° не строится
    const split = single && k === Math.floor(n / 2);
    if (last && last.ci === ci && !split) last.pts.push(q);
    else runs.push({ ci, pts: [p, q] });
  }
  const segs: RSeg[] = [];
  for (const run of runs) {
    const cv = curves[run.ci];
    const a = run.pts[0];
    const b = run.pts[run.pts.length - 1];
    if (cv.k === "line" || run.pts.length < 2) {
      segs.push({ k: "line", a, b });
      continue;
    }
    // Угол (или параметр эллипса) точки и накопленный поворот по участку
    const ang = (q: V2) =>
      cv.k === "arc" ? Math.atan2(q[1] - cv.c[1], q[0] - cv.c[0]) : Math.atan2((q[1] - cv.c[1]) / cv.ry, (q[0] - cv.c[0]) / cv.rx);
    let sw = 0;
    for (let j = 1; j < run.pts.length; j++) {
      let d = ang(run.pts[j]) - ang(run.pts[j - 1]);
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      sw += d;
    }
    const a0 = ang(a);
    if (cv.k === "arc") {
      const am = a0 + sw / 2;
      segs.push({ k: "arc", a, m: [cv.c[0] + cv.r * Math.cos(am), cv.c[1] + cv.r * Math.sin(am)], b });
    } else {
      // Эллипс — участками не длиннее четверти, по три точки на каждом
      const parts = Math.max(1, Math.ceil(Math.abs(sw) / (Math.PI / 2)));
      const pt = (t: number): V2 => [cv.c[0] + cv.rx * Math.cos(t), cv.c[1] + cv.ry * Math.sin(t)];
      for (let j = 0; j < parts; j++) {
        const t0 = a0 + (sw * j) / parts;
        const t1 = a0 + (sw * (j + 1)) / parts;
        segs.push({ k: "ell", a: j ? pt(t0) : a, m: pt((t0 + t1) / 2), b: j === parts - 1 ? b : pt(t1), c: cv.c, rx: cv.rx, ry: cv.ry });
      }
    }
  }
  return { segs, pts };
}
