// Геометрические связи эскиза и численный решатель (все связи одновременно).
// Размеры (длина, диаметр) — тоже связи: перетаскивание точек их не меняет.
import { arcGeom, closestOnSegment, dist2, handles, segments, type Profile, type V2 } from "./sketch";

export type EntKind = "pt" | "line" | "circle";
/** Элемент эскиза: профиль i, номер элемента e (точка-ручка, сторона или окружность) */
export interface EntRef {
  i: number;
  e: number;
  t: EntKind;
}

/**
 * Начало координат эскиза как элемент связей (неподвижен):
 * точка e=0 — начало, линия e=0 — ось X, линия e=1 — ось Y
 */
export const ORIGIN = -100;
const BIG = 1e5;

export type ConstraintKind =
  | "parallel"
  | "perpendicular"
  | "collinear"
  | "tangent"
  | "coincident"
  | "onLine"
  | "horizontal"
  | "vertical"
  | "equal"
  | "concentric"
  | "fix"
  | "length"
  | "diameter"
  /** Угол между отрезками, градусы */
  | "angle"
  /** Расстояние между параллельными отрезками */
  | "distance";

/** Связь между a и b; у связей одного элемента (горизонталь, закрепление, размер) b = a */
export interface Constraint {
  kind: ConstraintKind;
  a: EntRef;
  b: EntRef;
  /** Поставлена автоматически при рисовании */
  auto?: boolean;
  /** Значение размера: длина отрезка или диаметр окружности */
  v?: number;
  /** Место закреплённой точки */
  p?: V2;
}

export interface ConstraintDef {
  kind: ConstraintKind;
  label: string;
  glyph: string;
  hint: string;
  first: EntKind[];
  second: EntKind[];
  /** Ставится инструментом «Размер», а не из сетки связей */
  dim?: boolean;
}

export const CONSTRAINTS: ConstraintDef[] = [
  { kind: "parallel", label: "Параллельно", glyph: "∥", hint: "Коснитесь двух отрезков (или оси X/Y) — второй повернётся параллельно первому", first: ["line"], second: ["line"] },
  { kind: "perpendicular", label: "Перпендикулярно", glyph: "⊥", hint: "Коснитесь двух отрезков (или оси X/Y) — второй повернётся под прямым углом", first: ["line"], second: ["line"] },
  { kind: "collinear", label: "На одной прямой", glyph: "≡", hint: "Коснитесь двух отрезков — второй встанет на прямую первого (можно на ось X/Y)", first: ["line"], second: ["line"] },
  { kind: "tangent", label: "Касание", glyph: "◠", hint: "Коснитесь окружности и отрезка — окружность сдвинется до касания (или двух окружностей)", first: ["circle", "line"], second: ["circle", "line"] },
  { kind: "coincident", label: "Совпадение", glyph: "●", hint: "Коснитесь двух точек — вторая переместится в первую (можно в начало координат)", first: ["pt"], second: ["pt"] },
  { kind: "onLine", label: "Точка на линии", glyph: "∈", hint: "Коснитесь точки, затем отрезка или оси X/Y", first: ["pt"], second: ["line"] },
  { kind: "horizontal", label: "Горизонтально", glyph: "Г", hint: "Коснитесь отрезка — он станет горизонтальным", first: ["line"], second: [] },
  { kind: "vertical", label: "Вертикально", glyph: "В", hint: "Коснитесь отрезка — он станет вертикальным", first: ["line"], second: [] },
  { kind: "equal", label: "Равенство", glyph: "=", hint: "Коснитесь двух отрезков (длины) или двух окружностей (радиусы) — второй станет равен первому", first: ["line", "circle"], second: ["line", "circle"] },
  { kind: "concentric", label: "Концентрично", glyph: "◎", hint: "Коснитесь двух окружностей или дуг — центр второй совпадёт с центром первой", first: ["circle"], second: ["circle"] },
  { kind: "fix", label: "Закрепить", glyph: "⚓", hint: "Коснитесь точки — она останется на месте при любых правках", first: ["pt"], second: [] },
  { kind: "length", label: "Длина", glyph: "↔", hint: "", first: ["line"], second: [], dim: true },
  { kind: "diameter", label: "Диаметр", glyph: "Ø", hint: "", first: ["circle"], second: [], dim: true },
  { kind: "angle", label: "Угол", glyph: "∠", hint: "", first: ["line"], second: ["line"], dim: true },
  { kind: "distance", label: "Расстояние", glyph: "↕", hint: "", first: ["line"], second: ["line"], dim: true },
];

export const sameEnt = (a: EntRef, b: EntRef) => a.i === b.i && a.e === b.e && a.t === b.t;

// ---------- 2D-векторы ----------
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const norm = (a: V2): V2 => mul(a, 1 / (len(a) || 1));
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];

// ---------- элементы профилей ----------

/** Отрезки, к которым применимы связи: стороны, звенья ломаной, ось (осевая паза — нет) */
export function lines(p: Profile): [V2, V2][] {
  return p.kind === "slot" ? [] : segments(p);
}

/** Окружность элемента: круг или окружность, на которой лежит дуга */
function circleOf(p: Profile): { c: V2; r: number } | null {
  if (p.kind === "circle") return { c: [p.cx, p.cy], r: p.r };
  if (p.kind === "arc") {
    const g = arcGeom(p);
    return g && { c: g.c, r: g.r };
  }
  return null;
}

/** Геометрия элемента (начало координат — тоже элемент) */
function ptOf(ps: Profile[], r: EntRef): V2 {
  return r.i === ORIGIN ? [0, 0] : handles(ps[r.i])[r.e];
}
export function lineOf(ps: Profile[], r: EntRef): [V2, V2] {
  if (r.i === ORIGIN)
    return r.e === 0
      ? [
          [-BIG, 0],
          [BIG, 0],
        ]
      : [
          [0, -BIG],
          [0, BIG],
        ];
  return lines(ps[r.i])[r.e];
}
const circOf = (ps: Profile[], r: EntRef) => (r.i === ORIGIN ? null : circleOf(ps[r.i]));

/**
 * Угол между отрезками так, как его видно на эскизе: от точки пересечения прямых
 * лучи идут к серединам отрезков. null — отрезки параллельны
 */
export function angleGeom(l1: [V2, V2], l2: [V2, V2]): { X: V2; a1: number; a2: number; angle: number } | null {
  const d1 = sub(l1[1], l1[0]);
  const d2 = sub(l2[1], l2[0]);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9 * (len(d1) * len(d2) || 1)) return null;
  const q = sub(l2[0], l1[0]);
  const t = (q[0] * d2[1] - q[1] * d2[0]) / den;
  const X: V2 = add(l1[0], mul(d1, t));
  const ray = (l: [V2, V2], d: V2): V2 => {
    const r = sub(mul(add(l[0], l[1]), 0.5), X);
    return len(r) > 1e-9 ? r : d;
  };
  const r1 = ray(l1, d1);
  const r2 = ray(l2, d2);
  return { X, a1: Math.atan2(r1[1], r1[0]), a2: Math.atan2(r2[1], r2[0]), angle: Math.atan2(Math.abs(r1[0] * r2[1] - r1[1] * r2[0]), dot(r1, r2)) };
}

/** Прямоугольник с наклонной стороной уже не прямоугольник — переводим в многоугольник */
export function toPoly(p: Profile): Profile {
  return p.kind === "rect" ? { kind: "poly", pts: handles(p).slice(0, 4), radii: p.radii } : p;
}

/** Ближайший к точке элемент нужного типа в пределах tol; withOrigin — и начало координат/оси */
export function pickEntity(profiles: Profile[], q: V2, tol: number, kinds: EntKind[], withOrigin = false): EntRef | null {
  let best: EntRef | null = null;
  let bestD = tol;
  // Точки важнее линий: иначе в угол многоугольника невозможно попасть
  const consider = (ref: EntRef, d: number, bias = 0) => {
    if (d - bias < bestD) [best, bestD] = [ref, d - bias];
  };
  profiles.forEach((p, i) => {
    if (kinds.includes("pt")) handles(p).forEach((h, e) => consider({ i, e, t: "pt" }, dist2(h, q), tol * 0.3));
    if (kinds.includes("line")) lines(p).forEach(([a, b], e) => consider({ i, e, t: "line" }, dist2(q, closestOnSegment(q, a, b))));
    const c = circleOf(p);
    if (c && kinds.includes("circle")) consider({ i, e: 0, t: "circle" }, Math.abs(dist2(q, c.c) - c.r));
  });
  if (withOrigin) {
    // Начало и оси уступают элементам эскиза при равном расстоянии
    if (kinds.includes("pt")) consider({ i: ORIGIN, e: 0, t: "pt" }, len(q), tol * 0.2);
    if (kinds.includes("line")) {
      consider({ i: ORIGIN, e: 0, t: "line" }, Math.abs(q[1]) + tol * 0.15);
      consider({ i: ORIGIN, e: 1, t: "line" }, Math.abs(q[0]) + tol * 0.15);
    }
  }
  return best;
}

/** Название элемента для списка связей */
export function entName(r: EntRef): string {
  if (r.i === ORIGIN) return r.t === "pt" ? "начало координат" : r.e === 0 ? "ось X" : "ось Y";
  return `фигура ${r.i + 1}`;
}

/** Точка на экране для значка связи */
export function entityAnchor(profiles: Profile[], r: EntRef): V2 | null {
  if (r.i === ORIGIN) return r.t === "pt" ? [0, 0] : r.e === 0 ? [12, 0] : [0, 12];
  const p = profiles[r.i];
  if (!p) return null;
  if (r.t === "pt") return handles(p)[r.e] ?? null;
  if (r.t === "line") {
    const l = lines(p)[r.e];
    return l ? mul(add(l[0], l[1]), 0.5) : null;
  }
  const c = circleOf(p);
  return c ? [c.c[0], c.c[1] + c.r] : null;
}

/** Ссылается ли связь на существующие элементы */
export function isValidRef(profiles: Profile[], r: EntRef): boolean {
  if (r.i === ORIGIN) return r.t === "pt" ? r.e === 0 : r.t === "line" && (r.e === 0 || r.e === 1);
  const p = profiles[r.i];
  if (!p) return false;
  if (r.t === "pt") return r.e < handles(p).length;
  if (r.t === "line") return r.e < lines(p).length;
  return p.kind === "circle" || p.kind === "arc";
}

// ---------- решатель ----------
//
// Все связи решаются одновременно (метод Левенберга — Марквардта): переменные — параметры
// фигур (углы ломаных, центр и радиус окружности, x/y/ширина/высота прямоугольника…),
// каждая связь — одно-два уравнения «невязка = 0». Перетаскиваемая точка тянется к пальцу
// слабее, чем действуют связи: если связи не дают ей двигаться, она остаётся на месте.

/** Перетаскиваемая точка (профиль i, ручка h) */
export type Fixed = { i: number; h: number } | null;

/** Размер «точка — ребро/ось» со значением — тоже уравнение решателя */
export interface RefDimEq {
  i: number;
  h: number;
  ref: [V2, V2];
  v?: number;
}

/** Параметры фигуры как массив чисел и обратно */
function params(p: Profile): number[] {
  switch (p.kind) {
    case "rect":
      return [p.x, p.y, p.w, p.h];
    case "circle":
      return [p.cx, p.cy, p.r];
    case "ellipse":
      return [p.cx, p.cy, p.rx, p.ry];
    case "slot":
      return [...p.a, ...p.b, p.r];
    case "axis":
      return [...p.a, ...p.b];
    case "arc":
      return [...p.a, ...p.b, ...p.m];
    case "poly":
    case "path":
      return p.pts.flat();
    default:
      return [];
  }
}

function withParams(p: Profile, v: number[], o: number): Profile {
  switch (p.kind) {
    case "rect":
      return { ...p, x: v[o], y: v[o + 1], w: v[o + 2], h: v[o + 3] };
    case "circle":
      return { ...p, cx: v[o], cy: v[o + 1], r: v[o + 2] };
    case "ellipse":
      return { ...p, cx: v[o], cy: v[o + 1], rx: v[o + 2], ry: v[o + 3] };
    case "slot":
      return { ...p, a: [v[o], v[o + 1]], b: [v[o + 2], v[o + 3]], r: v[o + 4] };
    case "axis":
      return { ...p, a: [v[o], v[o + 1]], b: [v[o + 2], v[o + 3]] };
    case "arc":
      return { ...p, a: [v[o], v[o + 1]], b: [v[o + 2], v[o + 3]], m: [v[o + 4], v[o + 5]] };
    case "poly":
    case "path":
      return { ...p, pts: p.pts.map((_, k) => [v[o + 2 * k], v[o + 2 * k + 1]] as V2) };
    default:
      return p;
  }
}

const cross2 = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
/** Расстояние со знаком от точки до прямой ab */
const sdist = (p: V2, a: V2, b: V2) => cross2(sub(b, a), sub(p, a)) / (len(sub(b, a)) || 1e-12);

/** Невязки связи (в мм): все нули — связь выполнена */
function residuals(ps: Profile[], c: Constraint, out: number[]) {
  switch (c.kind) {
    case "coincident": {
      const p = ptOf(ps, c.a);
      const q = ptOf(ps, c.b);
      out.push(p[0] - q[0], p[1] - q[1]);
      break;
    }
    case "fix": {
      const p = ptOf(ps, c.a);
      if (c.p) out.push(p[0] - c.p[0], p[1] - c.p[1]);
      break;
    }
    case "onLine": {
      const [a, b] = lineOf(ps, c.b);
      out.push(sdist(ptOf(ps, c.a), a, b));
      break;
    }
    case "parallel":
    case "perpendicular": {
      const [a1, b1] = lineOf(ps, c.a);
      const [a2, b2] = lineOf(ps, c.b);
      const d1 = sub(b1, a1);
      const d2 = sub(b2, a2);
      // Безразмерный угол умножаем на длину отрезка (не больше 100 мм) — невязка в мм
      const L = Math.min(len(d1), len(d2), 100);
      const n1 = norm(d1);
      const n2 = norm(d2);
      out.push((c.kind === "parallel" ? cross2(n1, n2) : dot(n1, n2)) * L);
      break;
    }
    case "collinear": {
      const [a1, b1] = lineOf(ps, c.a);
      const [a2, b2] = lineOf(ps, c.b);
      out.push(sdist(a2, a1, b1), sdist(b2, a1, b1));
      break;
    }
    case "horizontal":
    case "vertical": {
      const [a, b] = lineOf(ps, c.a);
      out.push(c.kind === "horizontal" ? a[1] - b[1] : a[0] - b[0]);
      break;
    }
    case "equal": {
      if (c.a.t === "circle") {
        const ca = circOf(ps, c.a);
        const cb = circOf(ps, c.b);
        if (ca && cb) out.push(ca.r - cb.r);
      } else out.push(dist2(...lineOf(ps, c.a)) - dist2(...lineOf(ps, c.b)));
      break;
    }
    case "concentric": {
      const ca = circOf(ps, c.a);
      const cb = circOf(ps, c.b);
      if (ca && cb) out.push(ca.c[0] - cb.c[0], ca.c[1] - cb.c[1]);
      break;
    }
    case "angle": {
      const l1 = lineOf(ps, c.a);
      const l2 = lineOf(ps, c.b);
      const g = angleGeom(l1, l2);
      const L = Math.min(dist2(...l1), dist2(...l2), 100);
      // Параллельные — угол 0 (или 180°, если лучи смотрят в разные стороны)
      const ang = g ? g.angle : dot(sub(l1[1], l1[0]), sub(l2[1], l2[0])) >= 0 ? 0 : Math.PI;
      if (c.v !== undefined) out.push((ang - (c.v * Math.PI) / 180) * L);
      break;
    }
    case "distance": {
      const [a, b] = lineOf(ps, c.a);
      const [p, q] = lineOf(ps, c.b);
      if (c.v !== undefined) out.push(Math.abs(sdist(mul(add(p, q), 0.5), a, b)) - c.v);
      break;
    }
    case "length":
      if (c.v !== undefined) out.push(dist2(...lineOf(ps, c.a)) - c.v);
      break;
    case "diameter": {
      const ca = circOf(ps, c.a);
      if (ca && c.v !== undefined) out.push(2 * ca.r - c.v);
      break;
    }
    case "tangent": {
      const ca = c.a.t === "circle" ? circOf(ps, c.a) : null;
      const cb = c.b.t === "circle" ? circOf(ps, c.b) : null;
      if (ca && cb) {
        const d = dist2(ca.c, cb.c);
        // Внутреннее касание — если одна окружность внутри другой
        out.push(d < Math.abs(ca.r - cb.r) ? d - Math.abs(ca.r - cb.r) : d - (ca.r + cb.r));
      } else {
        const circ = ca ?? cb;
        const line = ca ? c.b : c.a;
        if (circ) {
          const [a, b] = lineOf(ps, line);
          out.push(Math.abs(sdist(circ.c, a, b)) - circ.r);
        }
      }
      break;
    }
  }
}

/** Решить систему A·x = b (Гаусс с выбором главного элемента); A портится */
function linsolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > Math.abs(A[piv][k])) piv = i;
    if (Math.abs(A[piv][k]) < 1e-14) return null;
    [A[k], A[piv]] = [A[piv], A[k]];
    [b[k], b[piv]] = [b[piv], b[k]];
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / A[k][k];
      if (!f) continue;
      for (let j = k; j < n; j++) A[i][j] -= f * A[k][j];
      b[i] -= f * b[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

const W_CON = 30; // вес связей
const W_DRAG = 1; // палец тянет точку слабее, чем держат связи
const W_REG = 0.02; // остальное по возможности остаётся на месте

/**
 * Решить связи на месте. fixed — точка под пальцем (её положение — желаемое, не обязательное).
 * Возвращает false, если связи противоречат друг другу и выполнить все нельзя.
 */
export function solve(profiles: Profile[], constraints: Constraint[], fixed: Fixed = null, refDims: RefDimEq[] = []): boolean {
  const cons = constraints.filter((c) => isValidRef(profiles, c.a) && isValidRef(profiles, c.b));
  const rds = refDims.filter((r) => r.v !== undefined && profiles[r.i] && handles(profiles[r.i])[r.h]);
  if (!cons.length && !rds.length) return true;
  // Переменные — только фигуры, участвующие в связях
  const used = new Set<number>();
  for (const c of cons) for (const r of [c.a, c.b]) if (r.i !== ORIGIN) used.add(r.i);
  for (const r of rds) used.add(r.i);
  const idx = [...used].sort((a, b) => a - b);
  const offs = new Map<number, number>();
  const x0: number[] = [];
  for (const i of idx) {
    offs.set(i, x0.length);
    x0.push(...params(profiles[i]));
  }
  const n = x0.length;
  if (!n) return true;
  const build = (x: number[]) => {
    const ps = profiles.slice();
    for (const i of idx) ps[i] = withParams(profiles[i], x, offs.get(i)!);
    return ps;
  };
  const dragTarget = fixed && used.has(fixed.i) ? handles(profiles[fixed.i])[fixed.h] : null;

  /** Все невязки: связи, размеры до граней, палец, «остаться на месте» */
  let wReg = W_REG;
  const resid = (x: number[], withDrag: boolean, anchor: number[]) => {
    const ps = build(x);
    const r: number[] = [];
    for (const c of cons) residuals(ps, c, r);
    for (const d of rds) r.push(Math.abs(sdist(handles(ps[d.i])[d.h], d.ref[0], d.ref[1])) - d.v!);
    const m = r.length;
    for (let k = 0; k < m; k++) r[k] *= W_CON;
    if (withDrag && dragTarget) {
      const q = handles(ps[fixed!.i])[fixed!.h];
      r.push(W_DRAG * (q[0] - dragTarget[0]), W_DRAG * (q[1] - dragTarget[1]));
    }
    for (let j = 0; j < n; j++) r.push(wReg * (x[j] - anchor[j]));
    return { r, m };
  };

  let x = x0.slice();
  // Сначала с пальцем, потом без него — чтобы связи выполнились точно
  // Фазы: с пальцем, без пальца и (если связи ещё не точны) с почти отпущенным «остаться на месте»
  for (const phase of dragTarget ? ["drag", "free", "polish"] : ["free", "polish"]) {
    const withDrag = phase === "drag";
    if (phase === "polish") {
      const q = resid(x, false, x);
      const rr = q.r.slice(0, q.m);
      if (Math.max(0, ...rr.map(Math.abs)) < 1e-6 * W_CON) break;
      wReg = W_REG * 1e-3;
    }
    const anchor = x.slice();
    let lambda = 1e-3;
    let cur = resid(x, withDrag, anchor);
    let cost = cur.r.reduce((s, v) => s + v * v, 0);
    for (let it = 0; it < 60; it++) {
      // Связи выполнены (с пальцем — ещё и точка дошла, насколько можно): дальше не уточняем
      if (Math.max(0, ...cur.r.slice(0, cur.m).map(Math.abs)) < 1e-7 * W_CON && (!withDrag || it > 3)) break;
      // Якобиан численно
      const J: number[][] = cur.r.map(() => new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        const h = 1e-6 * Math.max(1, Math.abs(x[j]));
        const xj = x[j];
        x[j] = xj + h;
        const rj = resid(x, withDrag, anchor).r;
        x[j] = xj;
        for (let k = 0; k < rj.length; k++) J[k][j] = (rj[k] - cur.r[k]) / h;
      }
      const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
      const g = new Array(n).fill(0);
      for (let k = 0; k < J.length; k++) {
        const row = J[k];
        const rk = cur.r[k];
        for (let a = 0; a < n; a++) {
          if (!row[a]) continue;
          g[a] += row[a] * rk;
          for (let b = a; b < n; b++) A[a][b] += row[a] * row[b];
        }
      }
      for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const M = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + lambda : v)));
        const step = linsolve(M, g.map((v) => -v));
        if (!step) {
          lambda *= 10;
          continue;
        }
        const xn = x.map((v, j) => v + step[j]);
        const nr = resid(xn, withDrag, anchor);
        const nc = nr.r.reduce((s, v) => s + v * v, 0);
        if (nc < cost) {
          x = xn;
          cur = nr;
          cost = nc;
          lambda = Math.max(1e-9, lambda / 3);
          improved = true;
        } else lambda *= 4;
      }
      if (!improved) break;
    }
  }
  const ps = build(x);
  for (const i of idx) profiles[i] = ps[i];
  // Проверка: всё ли выполнено
  const r: number[] = [];
  for (const c of cons) residuals(ps, c, r);
  for (const d of rds) r.push(Math.abs(sdist(handles(ps[d.i])[d.h], d.ref[0], d.ref[1])) - d.v!);
  return r.every((v) => Math.abs(v) < 1e-3);
}

/** Связям, поворачивающим или сдвигающим стороны, нужен многоугольник вместо прямоугольника */
const NEEDS_POLY: ConstraintKind[] = ["parallel", "perpendicular", "collinear", "tangent", "onLine"];

/**
 * Подготовить профили к новой связи. Прямоугольник, ставший многоугольником, сохраняет
 * прямые углы — возвращаются связи перпендикулярности его сторон (их нужно добавить)
 */
export function prepareProfiles(profiles: Profile[], c: Constraint): Constraint[] {
  const extra: Constraint[] = [];
  if (!NEEDS_POLY.includes(c.kind)) return extra;
  for (const r of [c.a, c.b]) {
    if (r.t !== "line" || r.i === ORIGIN || profiles[r.i]?.kind !== "rect") continue;
    profiles[r.i] = toPoly(profiles[r.i]);
    for (let e = 0; e < 3; e++)
      extra.push({ kind: "perpendicular", a: { i: r.i, e, t: "line" }, b: { i: r.i, e: e + 1, t: "line" }, auto: true });
  }
  return extra;
}
