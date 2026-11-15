// Обрезка линий эскиза: касание участка линии, окружности или дуги убирает его
// до ближайших пересечений с другими элементами (или целиком, если пересечений нет).
import { arcGeom, closestOnSegment, dist2, outline, rectCorners, type Profile, type V2 } from "./sketch";

const TAU = Math.PI * 2;
const EPS = 1e-6;

type Prim = { k: "seg"; a: V2; b: V2 } | { k: "circ"; c: V2; r: number; a0: number; sw: number };

const normAng = (x: number) => ((x % TAU) + TAU) % TAU;
/** Угол лежит на дуге (от a0 на sw со знаком) */
function onArc(th: number, a0: number, sw: number) {
  if (Math.abs(sw) >= TAU - 1e-9) return true;
  const rel = normAng((th - a0) * Math.sign(sw));
  return rel <= Math.abs(sw) + 1e-9;
}

/** Стороны замкнутого контура или звенья линии */
function sides(p: Profile): [V2, V2][] {
  if (p.kind === "rect" || p.kind === "poly") {
    const pts = p.kind === "rect" ? rectCorners(p) : p.pts;
    return pts.map((a, j) => [a, pts[(j + 1) % pts.length]] as [V2, V2]);
  }
  if (p.kind === "path") return p.pts.slice(0, -1).map((a, j) => [a, p.pts[j + 1]] as [V2, V2]);
  if (p.kind === "axis") return [[p.a, p.b]];
  return [];
}

/** Элементы фигуры для поиска пересечений */
function prims(p: Profile): Prim[] {
  if (p.kind === "circle") return [{ k: "circ", c: [p.cx, p.cy], r: p.r, a0: 0, sw: TAU }];
  if (p.kind === "arc") {
    const g = arcGeom(p);
    return g ? [{ k: "circ", ...g }] : [{ k: "seg", a: p.a, b: p.b }];
  }
  // Скруглённые углы, эллипс и паз — по ломаной контура
  if (p.kind === "ellipse" || p.kind === "slot" || ((p.kind === "rect" || p.kind === "poly") && p.radii?.some((r) => r > 0))) {
    const o = outline(p);
    return o.map((a, j) => ({ k: "seg", a, b: o[(j + 1) % o.length] }) as Prim);
  }
  return sides(p).map(([a, b]) => ({ k: "seg", a, b }));
}

/** Пересечения прямой a + t(b − a) с окружностью: параметры t */
function lineCircleT(a: V2, b: V2, c: V2, r: number): number[] {
  const d: V2 = [b[0] - a[0], b[1] - a[1]];
  const f: V2 = [a[0] - c[0], a[1] - c[1]];
  const A = d[0] * d[0] + d[1] * d[1];
  const B = 2 * (f[0] * d[0] + f[1] * d[1]);
  const C = f[0] * f[0] + f[1] * f[1] - r * r;
  const disc = B * B - 4 * A * C;
  if (A < 1e-18 || disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}

function circleCircle(c1: V2, r1: number, c2: V2, r2: number): V2[] {
  const d = dist2(c1, c2);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m: V2 = [c1[0] + ((c2[0] - c1[0]) * a) / d, c1[1] + ((c2[1] - c1[1]) * a) / d];
  const o: V2 = [(-(c2[1] - c1[1]) * h) / d, ((c2[0] - c1[0]) * h) / d];
  return [
    [m[0] + o[0], m[1] + o[1]],
    [m[0] - o[0], m[1] - o[1]],
  ];
}

/** Точки пересечения элемента-цели с элементом other */
function hits(target: Prim, other: Prim): V2[] {
  if (target.k === "seg" && other.k === "seg") {
    const r: V2 = [target.b[0] - target.a[0], target.b[1] - target.a[1]];
    const s: V2 = [other.b[0] - other.a[0], other.b[1] - other.a[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return [];
    const q: V2 = [other.a[0] - target.a[0], other.a[1] - target.a[1]];
    const t = (q[0] * s[1] - q[1] * s[0]) / den;
    const u = (q[0] * r[1] - q[1] * r[0]) / den;
    return u >= -EPS && u <= 1 + EPS && t >= -EPS && t <= 1 + EPS ? [[target.a[0] + r[0] * t, target.a[1] + r[1] * t]] : [];
  }
  if (target.k === "seg" || other.k === "seg") {
    const sg = (target.k === "seg" ? target : other) as Extract<Prim, { k: "seg" }>;
    const ci = (target.k === "circ" ? target : other) as Extract<Prim, { k: "circ" }>;
    return lineCircleT(sg.a, sg.b, ci.c, ci.r)
      .filter((t) => t >= -EPS && t <= 1 + EPS)
      .map((t) => [sg.a[0] + (sg.b[0] - sg.a[0]) * t, sg.a[1] + (sg.b[1] - sg.a[1]) * t] as V2)
      .filter((p) => onArc(Math.atan2(p[1] - ci.c[1], p[0] - ci.c[0]), ci.a0, ci.sw));
  }
  return circleCircle(target.c, target.r, other.c, other.r).filter(
    (p) => onArc(Math.atan2(p[1] - target.c[1], p[0] - target.c[0]), target.a0, target.sw) && onArc(Math.atan2(p[1] - other.c[1], p[0] - other.c[0]), other.a0, other.sw),
  );
}

export interface TrimResult {
  /** Профиль, который заменяется */
  index: number;
  /** Что от него осталось (пусто — удалить целиком) */
  parts: Profile[];
}

/** Обрезать элемент под точкой q (допуск tol в мм); null — под касанием нечего обрезать */
export function trimAt(profiles: Profile[], q: V2, tol: number): TrimResult | null {
  // Ближайший элемент: сторона/звено линии, окружность или дуга
  let best: { i: number; seg?: number; d: number } | null = null;
  profiles.forEach((p, i) => {
    if (p.kind === "rect" || p.kind === "poly" || p.kind === "path") {
      sides(p).forEach(([a, b], seg) => {
        const d = dist2(q, closestOnSegment(q, a, b));
        if (d < tol && (!best || d < best.d)) best = { i, seg, d };
      });
    } else if (p.kind === "circle" || p.kind === "arc") {
      const o = outline(p);
      const pts = p.kind === "circle" ? [...o, o[0]] : o;
      for (let k = 0; k + 1 < pts.length; k++) {
        const d = dist2(q, closestOnSegment(q, pts[k], pts[k + 1]));
        if (d < tol && (!best || d < best.d)) best = { i, d };
      }
    }
  });
  if (!best) return null;
  const { i, seg } = best as { i: number; seg?: number };
  const P = profiles[i];

  // Все остальные элементы: чужие фигуры и другие стороны этой же
  const others: Prim[] = [];
  profiles.forEach((p, j) => {
    if (j !== i) others.push(...prims(p));
  });
  if (seg !== undefined) sides(P).forEach(([a, b], k) => k !== seg && others.push({ k: "seg", a, b }));

  if (seg !== undefined) {
    const [a, b] = sides(P)[seg];
    const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1;
    const par = (p: V2) => ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2;
    const at = (t: number): V2 => [+(a[0] + (b[0] - a[0]) * t).toFixed(6), +(a[1] + (b[1] - a[1]) * t).toFixed(6)];
    const t0 = par(q);
    const ts = others.flatMap((o) => hits({ k: "seg", a, b }, o)).map(par);
    const lo = Math.max(0, ...ts.filter((t) => t < t0 - EPS && t > EPS));
    const hi = Math.min(1, ...ts.filter((t) => t > t0 + EPS && t < 1 - EPS));
    const head = lo > EPS ? [at(lo)] : [];
    const tail = hi < 1 - EPS ? [at(hi)] : [];
    if (P.kind === "path") {
      const first = [...P.pts.slice(0, seg + 1), ...head];
      const second = [...tail, ...P.pts.slice(seg + 1)];
      return { index: i, parts: [first, second].filter((pts) => pts.length >= 2).map((pts) => ({ kind: "path", pts }) as Profile) };
    }
    // Замкнутый контур раскрывается в линию: от конца вырезанного участка по кругу до его начала
    const pts = P.kind === "rect" ? rectCorners(P) : (P as Extract<Profile, { kind: "poly" }>).pts;
    const n = pts.length;
    const ring = Array.from({ length: n }, (_, k) => pts[(seg + 1 + k) % n]);
    return { index: i, parts: [{ kind: "path", pts: [...tail, ...ring, ...head] }] };
  }

  // Окружность или дуга: параметр — угол
  const circ = prims(P)[0];
  if (circ.k !== "circ") return { index: i, parts: [] };
  const { c, r, a0, sw } = circ;
  const full = P.kind === "circle";
  const angOf = (p: V2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  // Параметр по ходу дуги в долях (для окружности — от 0 до 1 по кругу)
  const par = (p: V2) => normAng((angOf(p) - a0) * Math.sign(sw)) / Math.abs(sw);
  const pt = (s: number): V2 => {
    const t = a0 + sw * s;
    return [+(c[0] + r * Math.cos(t)).toFixed(6), +(c[1] + r * Math.sin(t)).toFixed(6)];
  };
  const arcBetween = (s0: number, s1: number): Profile => ({ kind: "arc", a: pt(s0), b: pt(s1), m: pt((s0 + s1) / 2) });
  const s0 = par(q);
  const ss = others.flatMap((o) => hits(circ, o)).map(par);
  if (full) {
    const uniq = [...new Set(ss.map((s) => +s.toFixed(9)))].sort((x, y) => x - y);
    // Окружность режется хотя бы двумя точками; иначе удаляется целиком
    if (uniq.length < 2) return { index: i, parts: [] };
    const hi = uniq.find((s) => s > s0) ?? uniq[0] + 1;
    const lo = [...uniq].reverse().find((s) => s < s0) ?? uniq[uniq.length - 1] - 1;
    // Остаётся дуга от hi по кругу до lo (+1 оборот)
    return { index: i, parts: [arcBetween(hi, lo + 1)] };
  }
  const lo = Math.max(0, ...ss.filter((s) => s < s0 - EPS && s > EPS));
  const hi = Math.min(1, ...ss.filter((s) => s > s0 + EPS && s < 1 - EPS));
  const parts: Profile[] = [];
  if (lo > EPS) parts.push(arcBetween(0, lo));
  if (hi < 1 - EPS) parts.push(arcBetween(hi, 1));
  return { index: i, parts };
}
