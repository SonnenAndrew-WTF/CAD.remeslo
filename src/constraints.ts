// Геометрические связи эскиза и простой итеративный решатель.
// Каждая связь «проецирует» один из элементов так, чтобы условие выполнялось;
// несколько проходов по всем связям сходятся для типичных эскизов.
// Размеры (длина, диаметр) — тоже связи: перетаскивание точек их не меняет.
import { closestOnSegment, dist2, footOnLine, handles, moveHandle, segments, type Profile, type V2 } from "./sketch";

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
  | "fix"
  | "length"
  | "diameter";

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
  { kind: "fix", label: "Закрепить", glyph: "⚓", hint: "Коснитесь точки — она останется на месте при любых правках", first: ["pt"], second: [] },
  { kind: "length", label: "Длина", glyph: "↔", hint: "", first: ["line"], second: [], dim: true },
  { kind: "diameter", label: "Диаметр", glyph: "Ø", hint: "", first: ["circle"], second: [], dim: true },
];

export const sameEnt = (a: EntRef, b: EntRef) => a.i === b.i && a.e === b.e && a.t === b.t;

// ---------- 2D-векторы ----------
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const norm = (a: V2): V2 => mul(a, 1 / (len(a) || 1));
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const perp = (a: V2): V2 => [-a[1], a[0]];

// ---------- элементы профилей ----------

/** Отрезки, к которым применимы связи: стороны, звенья ломаной, ось (осевая паза — нет) */
export function lines(p: Profile): [V2, V2][] {
  return p.kind === "slot" ? [] : segments(p);
}

function circleOf(p: Profile): { c: V2; r: number } | null {
  return p.kind === "circle" ? { c: [p.cx, p.cy], r: p.r } : null;
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

/** Номер точки-ручки в конце отрезка e (у замкнутого контура последний отрезок идёт в точку 0) */
function endIdx(p: Profile, e: number) {
  return p.kind === "poly" || p.kind === "rect" ? (e + 1) % lines(p).length : e + 1;
}

/** Прямоугольник с наклонной стороной уже не прямоугольник — переводим в многоугольник */
export function toPoly(p: Profile): Profile {
  return p.kind === "rect" ? { kind: "poly", pts: handles(p).slice(0, 4), radii: p.radii } : p;
}

function setLine(p: Profile, e: number, a: V2, b: V2): Profile {
  if (p.kind === "axis") return { ...p, a, b };
  if (p.kind !== "poly" && p.kind !== "path") return p;
  const pts = [...p.pts];
  pts[e] = a;
  pts[(e + 1) % pts.length] = b;
  return { ...p, pts };
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
  return p.kind === "circle";
}

// ---------- решатель ----------

/** Перетаскиваемая точка (профиль i, ручка h) — неподвижна для решателя */
export type Fixed = { i: number; h: number } | null;
type FixedList = { i: number; h: number }[];

function touchesFixed(ps: Profile[], r: EntRef, fixed: FixedList): boolean {
  if (r.i === ORIGIN) return true;
  const p = ps[r.i];
  return fixed.some((f) => {
    if (f.i !== r.i) return false;
    if (r.t === "pt") return r.e === f.h;
    if (r.t === "line") return f.h === r.e || f.h === endIdx(p, r.e);
    return f.h === 0;
  });
}

/** Повернуть отрезок вокруг середины в направлении dir (выбирая ближайший из ±dir) */
function alignLine([a, b]: [V2, V2], dir: V2): [V2, V2] {
  const m = mul(add(a, b), 0.5);
  const half = len(sub(b, a)) / 2;
  const d = dot(sub(b, a), dir) >= 0 ? dir : mul(dir, -1);
  return [sub(m, mul(d, half)), add(m, mul(d, half))];
}

/** Задать длину отрезку: конец под пальцем (или закреплённый) остаётся на месте */
function setLength(ps: Profile[], mov: EntRef, L: number, fixed: FixedList) {
  const P = ps[mov.i];
  if (P.kind === "rect") {
    // Стороны 0 и 2 — ширина, 1 и 3 — высота; угол (x, y) на месте
    ps[mov.i] = mov.e % 2 === 0 ? { ...P, w: L } : { ...P, h: L };
    return;
  }
  const [a, b] = lines(P)[mov.e];
  const keepB = fixed.some((f) => f.i === mov.i && f.h === endIdx(P, mov.e)) && !fixed.some((f) => f.i === mov.i && f.h === mov.e);
  const d = norm(sub(b, a));
  if (len(sub(b, a)) < 1e-12) return;
  ps[mov.i] = keepB ? setLine(P, mov.e, sub(b, mul(d, L)), b) : setLine(P, mov.e, a, add(a, mul(d, L)));
}

/** Одна проекция: меняет «подвижный» элемент; возвращает величину изменения */
function applyOne(ps: Profile[], c: Constraint, fixed: FixedList): number {
  // По умолчанию двигаем второй элемент; если он под пальцем/закреплён — первый
  let [ref, mov] = [c.a, c.b];
  if (touchesFixed(ps, mov, fixed) && !touchesFixed(ps, ref, fixed)) [ref, mov] = [mov, ref];
  if (c.kind === "onLine" && !touchesFixed(ps, c.a, fixed)) [ref, mov] = [c.b, c.a]; // точка идёт к линии
  // Касание окружности и отрезка: двигаем окружность — сдвиг стороны ломал бы контур
  if (c.kind === "tangent" && c.a.t !== c.b.t) {
    const circle = c.a.t === "circle" ? c.a : c.b;
    const line = circle === c.a ? c.b : c.a;
    [ref, mov] = touchesFixed(ps, circle, fixed) ? [circle, line] : [line, circle];
  }
  // Начало координат неподвижно
  if (mov.i === ORIGIN) [ref, mov] = [mov, ref];
  if (mov.i === ORIGIN) return 0;
  const before = JSON.stringify(ps[mov.i]);
  const P = ps[mov.i];

  switch (c.kind) {
    case "fix":
      if (c.p) ps[mov.i] = moveHandle(P, mov.e, c.p);
      break;
    case "length":
      if (c.v && c.v > 0) setLength(ps, mov, c.v, fixed);
      break;
    case "diameter":
      if (P.kind === "circle" && c.v && c.v > 0) ps[mov.i] = { ...P, r: c.v / 2 };
      break;
    case "equal": {
      if (mov.t === "circle") {
        const cr = circOf(ps, ref);
        if (cr && P.kind === "circle") ps[mov.i] = { ...P, r: cr.r };
      } else {
        const [ra, rb] = lineOf(ps, ref);
        setLength(ps, mov, dist2(ra, rb), fixed);
      }
      break;
    }
    case "horizontal":
    case "vertical": {
      if (P.kind === "rect") break; // стороны прямоугольника и так по осям
      // Выравниваем одну координату концов; конец под пальцем остаётся на месте
      const k = c.kind === "horizontal" ? 1 : 0;
      const [a, b] = lines(P)[mov.e];
      const fa = fixed.some((f) => f.i === mov.i && f.h === mov.e);
      const fb = fixed.some((f) => f.i === mov.i && f.h === endIdx(P, mov.e));
      const v = fa ? a[k] : fb ? b[k] : (a[k] + b[k]) / 2;
      const a2 = [...a] as V2;
      const b2 = [...b] as V2;
      a2[k] = b2[k] = v;
      ps[mov.i] = setLine(P, mov.e, a2, b2);
      break;
    }
    case "coincident":
      ps[mov.i] = moveHandle(P, mov.e, ptOf(ps, ref));
      break;
    case "onLine": {
      if (mov.t === "pt") {
        const [a, b] = lineOf(ps, ref);
        ps[mov.i] = moveHandle(P, mov.e, footOnLine(handles(P)[mov.e], a, b));
      } else {
        // Точка неподвижна — сдвигаем линию перпендикулярно, чтобы прошла через точку
        const q = ptOf(ps, ref);
        const [a, b] = lines(P)[mov.e];
        const shift = sub(q, footOnLine(q, a, b));
        ps[mov.i] = setLine(P, mov.e, add(a, shift), add(b, shift));
      }
      break;
    }
    case "parallel":
    case "perpendicular":
    case "collinear": {
      const [ra, rb] = lineOf(ps, ref);
      const along = norm(sub(rb, ra));
      const dir = c.kind === "perpendicular" ? perp(along) : along;
      let seg = alignLine(lines(P)[mov.e], dir);
      if (c.kind === "collinear") {
        const m = mul(add(seg[0], seg[1]), 0.5);
        const shift = sub(footOnLine(m, ra, rb), m);
        seg = [add(seg[0], shift), add(seg[1], shift)];
      }
      ps[mov.i] = setLine(P, mov.e, seg[0], seg[1]);
      break;
    }
    case "tangent": {
      const cm = circleOf(P);
      const cr = circOf(ps, ref);
      if (cm && cr) {
        // Две окружности: внешнее касание, а если одна внутри другой — внутреннее
        const d = sub(cm.c, cr.c);
        const inside = len(d) < Math.abs(cm.r - cr.r);
        const target = inside ? Math.abs(cm.r - cr.r) : cm.r + cr.r;
        const c2 = add(cr.c, mul(norm(len(d) ? d : [1, 0]), target));
        ps[mov.i] = { ...(P as Extract<Profile, { kind: "circle" }>), cx: c2[0], cy: c2[1] };
      } else if (cm && ref.t === "line") {
        // Двигаем окружность перпендикулярно линии, сохраняя сторону
        const [a, b] = lineOf(ps, ref);
        const f = footOnLine(cm.c, a, b);
        const n = len(sub(cm.c, f)) > 1e-9 ? norm(sub(cm.c, f)) : norm(perp(sub(b, a)));
        const c2 = add(f, mul(n, cm.r));
        ps[mov.i] = { ...(P as Extract<Profile, { kind: "circle" }>), cx: c2[0], cy: c2[1] };
      } else if (cr && mov.t === "line") {
        // Окружность неподвижна — сдвигаем линию до касания
        const [a, b] = lines(P)[mov.e];
        const f = footOnLine(cr.c, a, b);
        const n = len(sub(f, cr.c)) > 1e-9 ? norm(sub(f, cr.c)) : norm(perp(sub(b, a)));
        const shift = sub(add(cr.c, mul(n, cr.r)), f);
        ps[mov.i] = setLine(P, mov.e, add(a, shift), add(b, shift));
      }
      break;
    }
  }
  return before === JSON.stringify(ps[mov.i]) ? 0 : 1;
}

/** Закреплённые связью «Закрепить» точки — для решателя неподвижны, как точка под пальцем */
export function fixedPoints(constraints: Constraint[]): FixedList {
  return constraints.filter((c) => c.kind === "fix").map((c) => ({ i: c.a.i, h: c.a.e }));
}

/** Решить все связи на месте (до 40 проходов); fixed — точка под пальцем */
export function solve(profiles: Profile[], constraints: Constraint[], fixed: Fixed = null) {
  const valid = constraints.filter((c) => isValidRef(profiles, c.a) && isValidRef(profiles, c.b));
  const list = [...fixedPoints(valid), ...(fixed ? [fixed] : [])];
  for (let it = 0; it < 40; it++) {
    let changed = 0;
    for (const c of valid) changed += applyOne(profiles, c, list);
    if (!changed) break;
  }
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
