// Распознавание фигур, нарисованных от руки: линия, ломаная, окружность, эллипс,
// прямоугольник, треугольник и многоугольник. Работает в координатах эскиза (мм).
import { dist2, type Profile, type V2 } from "./sketch";

/** Ломаная с равным шагом — плотность точек не должна влиять на подгонку */
function resample(pts: V2[], n: number): V2[] {
  const total = length(pts);
  if (total < 1e-9) return [pts[0]];
  const step = total / (n - 1);
  const out: V2[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let seg = dist2(a, b);
    while (acc + seg >= step && out.length < n) {
      const t = (step - acc) / seg;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(a);
      seg = dist2(a, b);
      acc = 0;
    }
    acc += seg;
  }
  while (out.length < n) out.push(pts[pts.length - 1]);
  return out;
}

const length = (pts: V2[]) => pts.slice(1).reduce((s, q, i) => s + dist2(pts[i], q), 0);

function distToSeg(p: V2, a: V2, b: V2) {
  const ab: V2 = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return dist2(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}

/** Дуглас — Пекер: углы ломаной */
function simplify(pts: V2[], eps: number): V2[] {
  if (pts.length < 3) return pts;
  let idx = 0;
  let dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], pts[0], pts[pts.length - 1]);
    if (d > dmax) [idx, dmax] = [i, d];
  }
  if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

/** Вершины замкнутой фигуры: делим контур в самой дальней от начала точке */
function closedCorners(pts: V2[], eps: number): V2[] {
  let far = 0;
  pts.forEach((q, i) => dist2(q, pts[0]) > dist2(pts[far], pts[0]) && (far = i));
  const a = simplify(pts.slice(0, far + 1), eps);
  const b = simplify([...pts.slice(far), pts[0]], eps);
  let vs = [...a.slice(0, -1), ...b.slice(0, -1)];
  // Начало штриха редко попадает в угол — убираем вершины почти на прямой
  for (let changed = true; changed && vs.length > 3; ) {
    changed = false;
    for (let i = 0; i < vs.length && vs.length > 3; i++) {
      const p = vs[(i + vs.length - 1) % vs.length];
      const n = vs[(i + 1) % vs.length];
      if (distToSeg(vs[i], p, n) < eps) {
        vs = vs.filter((_, k) => k !== i);
        changed = true;
      }
    }
  }
  return vs;
}

export interface Recognized {
  profile: Profile;
  name: string;
}

/**
 * pts — точки штриха, unit — сколько мм в пикселе экрана (допуски считаются от размера
 * фигуры и экрана), snap — привязка точек к сетке и существующим точкам эскиза
 */
export function recognize(raw: V2[], unit: number, snap: (q: V2) => V2, round: (v: number) => number): Recognized | null {
  const pts = raw.filter((q, i) => !i || dist2(q, raw[i - 1]) > unit * 0.5);
  const L = length(pts);
  if (pts.length < 2 || L < unit * 12) return null;
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const D = Math.hypot(maxX - minX, maxY - minY);
  const gap = dist2(pts[0], pts[pts.length - 1]);
  const closed = gap < Math.max(0.2 * D, unit * 25) && L > 1.6 * D;

  if (!closed) {
    const s = resample(pts, 64);
    const dev = Math.max(...s.map((q) => distToSeg(q, s[0], s[s.length - 1])));
    if (dev < Math.max(0.06 * L, unit * 6)) return { profile: { kind: "path", pts: [snap(pts[0]), snap(pts[pts.length - 1])] }, name: "Линия" };
    const vs = simplify(s, Math.max(0.05 * D, unit * 8));
    const out = vs.map((q, i) => (i === 0 || i === vs.length - 1 ? snap(q) : snap(q)));
    return { profile: { kind: "path", pts: out }, name: "Ломаная" };
  }

  const s = resample(pts, 72);
  // Эллипс (или окружность) с осями вдоль X/Y: отклонение от единичного «радиуса»
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2;
  const ry = (maxY - minY) / 2;
  if (rx > 1e-9 && ry > 1e-9) {
    const res = s.reduce((acc, q) => acc + Math.abs(Math.hypot((q[0] - cx) / rx, (q[1] - cy) / ry) - 1), 0) / s.length;
    if (res < 0.075) {
      const c = snap([cx, cy]);
      const k = rx / ry;
      if (k > 0.85 && k < 1.18) return { profile: { kind: "circle", cx: c[0], cy: c[1], r: round((rx + ry) / 2) }, name: "Окружность" };
      return { profile: { kind: "ellipse", cx: c[0], cy: c[1], rx: round(rx), ry: round(ry) }, name: "Эллипс" };
    }
  }

  const vs = closedCorners(s, Math.max(0.06 * D, unit * 8));
  if (vs.length < 3) return null;
  if (vs.length === 4) {
    // Стороны почти по осям — прямоугольник
    const axisAligned = vs.every((a, i) => {
      const b = vs[(i + 1) % 4];
      const ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0])) % (Math.PI / 2);
      return Math.min(ang, Math.PI / 2 - ang) < (14 * Math.PI) / 180;
    });
    if (axisAligned) {
      const x0 = (Math.min(...vs.map((q) => q[0])) + [...vs].sort((a, b) => a[0] - b[0])[1][0]) / 2;
      const x1 = (Math.max(...vs.map((q) => q[0])) + [...vs].sort((a, b) => b[0] - a[0])[1][0]) / 2;
      const y0 = (Math.min(...vs.map((q) => q[1])) + [...vs].sort((a, b) => a[1] - b[1])[1][1]) / 2;
      const y1 = (Math.max(...vs.map((q) => q[1])) + [...vs].sort((a, b) => b[1] - a[1])[1][1]) / 2;
      const a = snap([x0, y0]);
      const b = snap([x1, y1]);
      return { profile: { kind: "rect", x: a[0], y: a[1], w: b[0] - a[0], h: b[1] - a[1] }, name: "Прямоугольник" };
    }
  }
  const poly = vs.map(snap);
  return { profile: { kind: "poly", pts: poly }, name: vs.length === 3 ? "Треугольник" : `Многоугольник (${vs.length})` };
}
