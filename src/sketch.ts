// 2D-геометрия эскизов: плоскости, профили, точки-ручки, вспомогательная векторная математика.
// Без зависимостей от ядра и Three.js — чистые функции.

export type Vec3 = [number, number, number];
export type V2 = [number, number];

/** Плоскость эскиза: начало и ортонормированный базис (xDir × yDir = normal) */
export interface SketchPlane {
  origin: Vec3;
  xDir: Vec3;
  yDir: Vec3;
  normal: Vec3;
}

/** Участок границы авто-области: отрезок, дуга окружности или эллипса через точку m */
export type RSeg =
  | { k: "line"; a: V2; b: V2 }
  | { k: "arc"; a: V2; m: V2; b: V2 }
  | { k: "ell"; a: V2; m: V2; b: V2; c: V2; rx: number; ry: number };

/** Часть авто-области: внешняя граница и отверстия */
export interface RegionPart {
  outer: RSeg[];
  holes: RSeg[][];
}

/** radii — радиусы скругления углов в порядке вершин контура (0 — острый угол) */
export type Profile =
  | { kind: "rect"; x: number; y: number; w: number; h: number; radii?: number[] }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "slot"; a: V2; b: V2; r: number }
  | { kind: "poly"; pts: V2[]; radii?: number[] }
  /** Открытая ломаная — не вытягивается, но участвует в связях и привязках */
  | { kind: "path"; pts: V2[] }
  /** Ось — вспомогательная линия для тел вращения и массивов */
  | { kind: "axis"; a: V2; b: V2 }
  /**
   * Авто-область (одна или несколько соседних) — не хранится в эскизе, а вычисляется
   * из пересечений; pts — внешние границы ломаной для проверок и центра
   */
  | { kind: "region"; parts: RegionPart[]; pts: V2[] };

/** Замкнутый ли контур (можно вытянуть или повернуть) */
export const isClosed = (p: Profile) => p.kind !== "path" && p.kind !== "axis";

/** Размер от точки эскиза (профиль i, ручка h) до опорной линии ref (ребро тела или ось) */
export interface RefDim {
  i: number;
  h: number;
  ref: [V2, V2];
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
const clean = (a: Vec3): Vec3 => a.map((v) => Math.round(v * 1e6) / 1e6 + 0) as Vec3;

/**
 * Плоскость по точке и нормали. Ось Y эскиза — проекция мировой Z (для вертикальных
 * плоскостей «верх» эскиза совпадает с верхом мира), для горизонтальных X эскиза = мировой X.
 */
export function planeFrom(origin: Vec3, normal: Vec3): SketchPlane {
  const n = normalize(normal);
  let xDir: Vec3, yDir: Vec3;
  if (Math.abs(n[2]) < 0.99) {
    yDir = normalize(sub([0, 0, 1], scale(n, n[2])));
    xDir = cross(yDir, n);
  } else {
    xDir = [1, 0, 0];
    yDir = cross(n, xDir);
  }
  return { origin: clean(origin), xDir: clean(xDir), yDir: clean(yDir), normal: clean(n) };
}

export const STD_PLANES: Record<"XY" | "XZ" | "YZ", SketchPlane> = {
  XY: planeFrom([0, 0, 0], [0, 0, 1]),
  XZ: planeFrom([0, 0, 0], [0, -1, 0]),
  YZ: planeFrom([0, 0, 0], [1, 0, 0]),
};

/** Поворот вектора v вокруг единичной оси k на угол a (радианы), формула Родрига */
export function rotateVec(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** Параллельная плоскость на расстоянии d вдоль нормали */
export const offsetPlane = (pl: SketchPlane, d: number): SketchPlane => planeFrom(add(pl.origin, scale(pl.normal, d)), pl.normal);

/** Плоскость через ось (точка + направление), повёрнутая от базовой на угол в градусах */
export function anglePlane(pl: SketchPlane, axisPoint: Vec3, axisDir: Vec3, deg: number): SketchPlane {
  return planeFrom(axisPoint, rotateVec(pl.normal, normalize(axisDir), (deg * Math.PI) / 180));
}

/** Плоскость по трём точкам (null, если точки на одной прямой) */
export function plane3(a: Vec3, b: Vec3, c: Vec3): SketchPlane | null {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-9) return null;
  return planeFrom(scale(add(add(a, b), c), 1 / 3), n);
}

export const toWorld = (pl: SketchPlane, [u, v]: V2): Vec3 => add(pl.origin, add(scale(pl.xDir, u), scale(pl.yDir, v)));

export function toLocal(pl: SketchPlane, p: Vec3): V2 {
  const d = sub(p, pl.origin);
  return [dot(d, pl.xDir), dot(d, pl.yDir)];
}

// ---------- 2D-векторы ----------
const v2 = {
  add: (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]],
  sub: (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]],
  mul: (a: V2, k: number): V2 => [a[0] * k, a[1] * k],
  len: (a: V2) => Math.hypot(a[0], a[1]),
  norm: (a: V2): V2 => {
    const l = Math.hypot(a[0], a[1]) || 1;
    return [a[0] / l, a[1] / l];
  },
  dot: (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1],
};

export const dist2 = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Ближайшая точка отрезка ab к точке p */
export function closestOnSegment(p: V2, a: V2, b: V2): V2 {
  const ab = v2.sub(b, a);
  const l2 = v2.dot(ab, ab);
  const t = l2 ? Math.min(1, Math.max(0, v2.dot(v2.sub(p, a), ab) / l2)) : 0;
  return v2.add(a, v2.mul(ab, t));
}

/** Основание перпендикуляра из p на бесконечную прямую ab */
export function footOnLine(p: V2, a: V2, b: V2): V2 {
  const ab = v2.sub(b, a);
  const l2 = v2.dot(ab, ab) || 1;
  return v2.add(a, v2.mul(ab, v2.dot(v2.sub(p, a), ab) / l2));
}

const arc = (c: V2, r: number, a0: number, a1: number, n: number): V2[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as V2;
  });

/** Ломаная со скруглёнными углами (для отображения; само скругление строит ядро) */
export function roundCorners(pts: V2[], radii?: number[]): V2[] {
  if (!radii?.some((r) => r > 0)) return pts;
  const out: V2[] = [];
  const n = pts.length;
  pts.forEach((v, i) => {
    const r0 = radii[i] ?? 0;
    if (!(r0 > 0)) return out.push(v);
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const u1 = v2.norm(v2.sub(prev, v));
    const u2 = v2.norm(v2.sub(next, v));
    const theta = Math.acos(Math.max(-1, Math.min(1, v2.dot(u1, u2))));
    if (theta < 1e-3 || theta > Math.PI - 1e-3) return out.push(v);
    // Отступ касания не больше половины соседних сторон
    let t = r0 / Math.tan(theta / 2);
    t = Math.min(t, dist2(prev, v) / 2, dist2(next, v) / 2);
    const r = t * Math.tan(theta / 2);
    const t1 = v2.add(v, v2.mul(u1, t));
    const t2 = v2.add(v, v2.mul(u2, t));
    const c = v2.add(v, v2.mul(v2.norm(v2.add(u1, u2)), r / Math.sin(theta / 2)));
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    let a1 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    // Идём по короткой дуге
    if (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    if (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    out.push(...arc(c, r, a0, a1, 10));
  });
  return out;
}

export const rectCorners = (p: { x: number; y: number; w: number; h: number }): V2[] => [
  [p.x, p.y],
  [p.x + p.w, p.y],
  [p.x + p.w, p.y + p.h],
  [p.x, p.y + p.h],
];

/** Угловые точки, которые можно скруглить (rect — 4 угла, poly — все вершины) */
export function corners(p: Profile): V2[] {
  if (p.kind === "rect") return rectCorners(p);
  if (p.kind === "poly") return p.pts;
  return [];
}

/** Контур профиля как замкнутая ломаная */
export function outline(p: Profile): V2[] {
  switch (p.kind) {
    case "rect":
      return roundCorners(rectCorners(p), p.radii);
    case "poly":
      return roundCorners(p.pts, p.radii);
    case "circle":
      return arc([p.cx, p.cy], p.r, 0, Math.PI * 2, 72).slice(0, -1);
    case "ellipse":
      return Array.from({ length: 72 }, (_, i) => {
        const a = (i / 72) * Math.PI * 2;
        return [p.cx + p.rx * Math.cos(a), p.cy + p.ry * Math.sin(a)] as V2;
      });
    case "slot": {
      const ang = Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]);
      return [...arc(p.b, p.r, ang - Math.PI / 2, ang + Math.PI / 2, 24), ...arc(p.a, p.r, ang + Math.PI / 2, ang + (Math.PI * 3) / 2, 24)];
    }
    case "path":
      return p.pts;
    case "axis":
      return [p.a, p.b];
    case "region":
      return p.pts;
  }
}

export function centroid(p: Profile): V2 {
  switch (p.kind) {
    case "circle":
    case "ellipse":
      return [p.cx, p.cy];
    case "rect":
      return [p.x + p.w / 2, p.y + p.h / 2];
    case "slot":
    case "axis":
      return v2.mul(v2.add(p.a, p.b), 0.5);
    case "poly":
    case "path":
    case "region": {
      const n = p.pts.length;
      return [p.pts.reduce((s, q) => s + q[0], 0) / n, p.pts.reduce((s, q) => s + q[1], 0) / n];
    }
  }
}

// ---------- точки-ручки: перетаскивание и удаление ----------

/** Ручки профиля: углы/вершины, центры. У прямоугольника 5-я ручка — центр (сдвиг целиком) */
export function handles(p: Profile): V2[] {
  switch (p.kind) {
    case "rect":
      return [...rectCorners(p), centroid(p)];
    case "circle":
    case "ellipse":
      return [[p.cx, p.cy]];
    case "slot":
    case "axis":
      return [p.a, p.b];
    case "poly":
    case "path":
      return p.pts;
    case "region":
      return [];
  }
}

export const isCorner = (p: Profile, h: number) => (p.kind === "rect" && h < 4) || p.kind === "poly";

export function translateProfile(p: Profile, dx: number, dy: number): Profile {
  const t = (q: V2): V2 => [q[0] + dx, q[1] + dy];
  switch (p.kind) {
    case "rect":
      return { ...p, x: p.x + dx, y: p.y + dy };
    case "circle":
    case "ellipse":
      return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    case "slot":
    case "axis":
      return { ...p, a: t(p.a), b: t(p.b) };
    case "poly":
    case "path":
      return { ...p, pts: p.pts.map(t) };
    case "region":
      return p;
  }
}

/** Перенести ручку h в точку q */
export function moveHandle(p: Profile, h: number, q: V2): Profile {
  switch (p.kind) {
    case "rect": {
      if (h === 4) {
        const c = centroid(p);
        return translateProfile(p, q[0] - c[0], q[1] - c[1]);
      }
      // Противоположный угол остаётся на месте
      const opp = rectCorners(p)[(h + 2) % 4];
      return { ...rectFrom(opp, q), radii: p.radii } as Profile;
    }
    case "circle":
    case "ellipse":
      return { ...p, cx: q[0], cy: q[1] };
    case "slot":
    case "axis":
      return h === 0 ? { ...p, a: q } : { ...p, b: q };
    case "poly":
    case "path":
      return { ...p, pts: p.pts.map((x, i) => (i === h ? q : x)) };
    case "region":
      return p;
  }
}

/** Удалить точку: вершина многоугольника исчезает, угол прямоугольника превращает его в многоугольник */
export function deleteHandle(p: Profile, h: number): Profile | null {
  if (p.kind === "rect" && h < 4) {
    const keep = [0, 1, 2, 3].filter((i) => i !== h);
    return { kind: "poly", pts: keep.map((i) => rectCorners(p)[i]), radii: p.radii && keep.map((i) => p.radii![i]) };
  }
  if (p.kind === "poly" && p.pts.length > 3) {
    return { ...p, pts: p.pts.filter((_, i) => i !== h), radii: p.radii?.filter((_, i) => i !== h) };
  }
  if (p.kind === "path" && p.pts.length > 2) return { ...p, pts: p.pts.filter((_, i) => i !== h) };
  return null;
}

export function setCornerRadius(p: Profile, h: number | "all", r: number): Profile {
  if (p.kind !== "rect" && p.kind !== "poly") return p;
  const n = corners(p).length;
  const radii = Array.from({ length: n }, (_, i) => (h === "all" || i === h ? r : (p.radii?.[i] ?? 0)));
  return { ...p, radii };
}

/** Отрезки профиля (стороны многоугольника/прямоугольника, звенья ломаной, ось) */
export function segments(p: Profile): [V2, V2][] {
  if (p.kind === "rect" || p.kind === "poly") {
    const pts = p.kind === "poly" ? p.pts : rectCorners(p);
    return pts.map((a, j) => [a, pts[(j + 1) % pts.length]] as [V2, V2]);
  }
  if (p.kind === "path") return p.pts.slice(0, -1).map((a, j) => [a, p.pts[j + 1]] as [V2, V2]);
  if (p.kind === "axis" || p.kind === "slot") return [[p.a, p.b]];
  return [];
}

export type SnapKind = "end" | "mid" | "center" | "quad";
/** Точки привязки с типом: концы, середины отрезков, центры и квадранты окружностей */
export function snapPointsTyped(p: Profile): { p: V2; k: SnapKind }[] {
  if (p.kind === "ellipse" || p.kind === "circle") {
    const [rx, ry] = p.kind === "circle" ? [p.r, p.r] : [p.rx, p.ry];
    return [
      { p: [p.cx, p.cy], k: "center" },
      ...([[rx, 0], [-rx, 0], [0, ry], [0, -ry]] as V2[]).map(([dx, dy]) => ({ p: [p.cx + dx, p.cy + dy] as V2, k: "quad" as const })),
    ];
  }
  const ends = handles(p).map((q, i) => ({ p: q, k: (p.kind === "rect" && i === 4 ? "center" : "end") as SnapKind }));
  const mids = p.kind === "slot" ? [] : segments(p).map(([a, b]) => ({ p: v2.mul(v2.add(a, b), 0.5), k: "mid" as const }));
  return [...ends, ...mids];
}

/** Точки, к которым прилипает курсор */
export function snapPoints(p: Profile): V2[] {
  return snapPointsTyped(p).map((x) => x.p);
}

/** Прямоугольник по двум противоположным углам */
export function rectFrom(a: V2, b: V2): Profile {
  return { kind: "rect", x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

/** Прямоугольник из центра c до угла q */
export function rectFromCenter(c: V2, q: V2): Profile {
  const dx = Math.abs(q[0] - c[0]);
  const dy = Math.abs(q[1] - c[1]);
  return { kind: "rect", x: c[0] - dx, y: c[1] - dy, w: dx * 2, h: dy * 2 };
}

export const fmt = (v: number) => String(+v.toFixed(2));

export const PROFILE_NAMES = { rect: "Прямоугольник", circle: "Окружность", ellipse: "Эллипс", slot: "Паз", poly: "Многоугольник", path: "Линии", axis: "Ось", region: "Область" };
