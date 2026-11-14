// Геометрические связи эскиза и простой итеративный решатель.
// Каждая связь «проецирует» один из элементов так, чтобы условие выполнялось;
// несколько проходов по всем связям сходятся для типичных эскизов.
import { closestOnSegment, dist2, footOnLine, handles, moveHandle, segments, type Profile, type V2 } from "./sketch";

export type EntKind = "pt" | "line" | "circle";
/** Элемент эскиза: профиль i, номер элемента e (точка-ручка, сторона или окружность) */
export interface EntRef {
  i: number;
  e: number;
  t: EntKind;
}

export type ConstraintKind = "parallel" | "perpendicular" | "collinear" | "tangent" | "coincident" | "onLine";
export interface Constraint {
  kind: ConstraintKind;
  a: EntRef;
  b: EntRef;
}

export const CONSTRAINTS: { kind: ConstraintKind; label: string; glyph: string; hint: string; first: EntKind[]; second: EntKind[] }[] = [
  { kind: "parallel", label: "Параллельно", glyph: "∥", hint: "Коснитесь двух отрезков — второй повернётся параллельно первому", first: ["line"], second: ["line"] },
  { kind: "perpendicular", label: "Перпендикулярно", glyph: "⊥", hint: "Коснитесь двух отрезков — второй повернётся под прямым углом к первому", first: ["line"], second: ["line"] },
  { kind: "collinear", label: "На одной прямой", glyph: "≡", hint: "Коснитесь двух отрезков — второй встанет на прямую первого", first: ["line"], second: ["line"] },
  { kind: "tangent", label: "Касание", glyph: "◠", hint: "Коснитесь окружности и отрезка — окружность сдвинется до касания (или двух окружностей)", first: ["circle", "line"], second: ["circle", "line"] },
  { kind: "coincident", label: "Совпадение", glyph: "●", hint: "Коснитесь двух точек — вторая переместится в первую", first: ["pt"], second: ["pt"] },
  { kind: "onLine", label: "Точка на линии", glyph: "∈", hint: "Коснитесь точки, затем отрезка", first: ["pt"], second: ["line"] },
];

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

/** Ближайший к точке элемент нужного типа в пределах tol (в единицах эскиза) */
export function pickEntity(profiles: Profile[], q: V2, tol: number, kinds: EntKind[]): EntRef | null {
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
  return best;
}

/** Точка на экране для значка связи */
export function entityAnchor(profiles: Profile[], r: EntRef): V2 | null {
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
  const p = profiles[r.i];
  if (!p) return false;
  if (r.t === "pt") return r.e < handles(p).length;
  if (r.t === "line") return r.e < lines(p).length;
  return p.kind === "circle";
}

// ---------- решатель ----------

/** Перетаскиваемая точка (профиль i, ручка h) — неподвижна для решателя */
export type Fixed = { i: number; h: number } | null;

function touchesFixed(p: Profile, r: EntRef, fixed: Fixed): boolean {
  if (!fixed || fixed.i !== r.i) return false;
  if (r.t === "pt") return r.e === fixed.h;
  if (r.t === "line") {
    const n = lines(p).length;
    return fixed.h === r.e || fixed.h === (r.e + 1) % n;
  }
  return fixed.h === 0;
}

/** Повернуть отрезок вокруг середины в направлении dir (выбирая ближайший из ±dir) */
function alignLine([a, b]: [V2, V2], dir: V2): [V2, V2] {
  const m = mul(add(a, b), 0.5);
  const half = len(sub(b, a)) / 2;
  const d = dot(sub(b, a), dir) >= 0 ? dir : mul(dir, -1);
  return [sub(m, mul(d, half)), add(m, mul(d, half))];
}

/** Одна проекция: меняет «подвижный» элемент; возвращает величину изменения */
function applyOne(ps: Profile[], c: Constraint, fixed: Fixed): number {
  // По умолчанию двигаем второй элемент; если он под пальцем — первый
  let [ref, mov] = [c.a, c.b];
  if (touchesFixed(ps[mov.i], mov, fixed) && !touchesFixed(ps[ref.i], ref, fixed)) [ref, mov] = [mov, ref];
  if (c.kind === "onLine" && !touchesFixed(ps[c.a.i], c.a, fixed)) [ref, mov] = [c.b, c.a]; // точка идёт к линии
  // Касание окружности и отрезка: двигаем окружность — сдвиг стороны ломал бы контур
  if (c.kind === "tangent" && c.a.t !== c.b.t) {
    const circle = c.a.t === "circle" ? c.a : c.b;
    const line = circle === c.a ? c.b : c.a;
    [ref, mov] = touchesFixed(ps[circle.i], circle, fixed) ? [circle, line] : [line, circle];
  }
  const before = JSON.stringify(ps[mov.i]);
  const P = ps[mov.i];
  const R = ps[ref.i];

  switch (c.kind) {
    case "coincident": {
      const target = handles(R)[ref.e];
      ps[mov.i] = moveHandle(P, mov.e, target);
      break;
    }
    case "onLine": {
      if (mov.t === "pt") {
        const [a, b] = lines(R)[ref.e];
        ps[mov.i] = moveHandle(P, mov.e, footOnLine(handles(P)[mov.e], a, b));
      } else {
        // Точка неподвижна — сдвигаем линию перпендикулярно, чтобы прошла через точку
        const q = handles(R)[ref.e];
        const [a, b] = lines(P)[mov.e];
        const shift = sub(q, footOnLine(q, a, b));
        ps[mov.i] = setLine(P, mov.e, add(a, shift), add(b, shift));
      }
      break;
    }
    case "parallel":
    case "perpendicular":
    case "collinear": {
      const [ra, rb] = lines(R)[ref.e];
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
      const cr = circleOf(R);
      if (cm && cr) {
        // Две окружности: внешнее касание, а если одна внутри другой — внутреннее
        const d = sub(cm.c, cr.c);
        const inside = len(d) < Math.abs(cm.r - cr.r);
        const target = inside ? Math.abs(cm.r - cr.r) : cm.r + cr.r;
        const c2 = add(cr.c, mul(norm(len(d) ? d : [1, 0]), target));
        ps[mov.i] = { ...(P as Extract<Profile, { kind: "circle" }>), cx: c2[0], cy: c2[1] };
      } else if (cm && ref.t === "line") {
        // Двигаем окружность перпендикулярно линии, сохраняя сторону
        const [a, b] = lines(R)[ref.e];
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

/** Решить все связи на месте (до 40 проходов); fixed — точка под пальцем */
export function solve(profiles: Profile[], constraints: Constraint[], fixed: Fixed = null) {
  const valid = constraints.filter((c) => isValidRef(profiles, c.a) && isValidRef(profiles, c.b));
  for (let it = 0; it < 40; it++) {
    let changed = 0;
    for (const c of valid) changed += applyOne(profiles, c, fixed);
    if (!changed) break;
  }
}

/** Связь требует сторон — прямоугольник в ней превращаем в многоугольник */
export function prepareProfiles(profiles: Profile[], c: Constraint) {
  for (const r of [c.a, c.b]) if (r.t === "line") profiles[r.i] = toPoly(profiles[r.i]);
}
