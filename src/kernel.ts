// Обёртка над CAD-ядром (OpenCascade через replicad).
// Весь доступ к геометрии идёт через этот модуль, чтобы позже его можно было
// перенести в Web Worker, не трогая интерфейс.
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import {
  setOC,
  makeBaseBox,
  makeCylinder,
  makeSphere,
  makeCompound,
  exportSTEP,
  Plane,
  draw,
  drawRectangle,
  drawCircle,
  drawEllipse,
  basicFaceExtrusion,
  Vector,
  cast,
  getOC,
  deserializeShape,
  importSTEP,
  importSTL,
  type Edge,
  type Face,
  type Drawing,
  type Shape3D,
  type AnyShape,
} from "replicad";
import { corners, planeFrom, scale, type Profile, type SketchPlane, type V2, type Vec3 } from "./sketch";

export type Shape = Shape3D;
export type { Vec3, Profile, SketchPlane };

export type Primitive =
  | { kind: "box"; w: number; d: number; h: number }
  | { kind: "cylinder"; r: number; h: number }
  | { kind: "sphere"; r: number };

export interface MeshData {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  edges: Float32Array;
  /** Диапазоны индексов треугольников по граням; faceId = hashCode грани */
  faceGroups: { start: number; count: number; faceId: number }[];
  /** Диапазоны вершин в edges по рёбрам; edgeId = hashCode ребра */
  edgeGroups: { start: number; count: number; edgeId: number }[];
}

export async function initKernel(): Promise<void> {
  const OC = await (opencascade as any)({ locateFile: () => wasmUrl });
  setOC(OC);
}

export function buildPrimitive(p: Primitive, offset: Vec3): Shape {
  let s: Shape;
  switch (p.kind) {
    case "box":
      s = makeBaseBox(p.w, p.d, p.h);
      break;
    case "cylinder":
      s = makeCylinder(p.r, p.h);
      break;
    case "sphere":
      s = makeSphere(p.r).translate(0, 0, p.r);
      break;
  }
  return offset.some((v) => v !== 0) ? s.translate(offset) : s;
}

// Операции replicad могут освобождать исходные объекты, а история (undo)
// хранит старые фигуры — поэтому всегда работаем с копиями.
export const translate = (s: Shape, d: Vec3): Shape => s.clone().translate(d);
export const union = (a: Shape, b: Shape): Shape => a.clone().fuse(b.clone());
export const subtract = (a: Shape, b: Shape): Shape => a.clone().cut(b.clone());
export const intersect = (a: Shape, b: Shape): Shape => a.clone().intersect(b.clone());
export const fillet = (s: Shape, r: number): Shape => s.clone().fillet(r);
export const chamfer = (s: Shape, r: number): Shape => s.clone().chamfer(r);

/** Скругление/фаска только выбранных рёбер (id = hashCode ребра) */
export function edgeOp(s: Shape, kind: "fillet" | "chamfer", edgeIds: number[], r: number): Shape {
  const ids = new Set(edgeIds);
  const pick = (e: Edge) => (ids.has(e.hashCode) ? r : null);
  return kind === "fillet" ? s.clone().fillet(pick) : s.clone().chamfer(pick);
}

function findFace(s: Shape, faceId: number): Face {
  const f = s.faces.find((x) => x.hashCode === faceId);
  if (!f) throw new Error("Грань не найдена");
  return f;
}

/** Нормаль и центр грани (для ручки «тяни-толкай») */
export function faceFrame(s: Shape, faceId: number): { center: Vec3; normal: Vec3; planar: boolean } {
  const f = findFace(s, faceId);
  const c = f.center;
  const n = f.normalAt();
  return { center: [c.x, c.y, c.z], normal: [n.x, n.y, n.z], planar: f.geomType === "PLANE" };
}

/**
 * Грань + все гладко (касательно) примыкающие к ней грани — скругления и т.п.
 * При «тяни-толкай» они сдвигаются вместе с гранью, иначе скругление
 * осталось бы торчать «стенкой» на старом месте.
 */
function tangentChain(s: Shape, start: Face): Face[] {
  const faces = s.faces;
  const dir = start.normalAt();
  // Боковые грани (перпендикулярные сдвигу) не берём: их «заметание» вырождено,
  // и через них цепочка расползлась бы по всему телу
  const facesDir = (g: Face) => {
    const m = g.normalAt();
    return m.x * dir.x + m.y * dir.y + m.z * dir.z > 0.05;
  };
  const byEdge = new Map<number, Face[]>();
  for (const f of faces) for (const e of f.edges) byEdge.set(e.hashCode, [...(byEdge.get(e.hashCode) ?? []), f]);
  const chain = [start];
  const seen = new Set([start.hashCode]);
  for (let i = 0; i < chain.length; i++) {
    for (const e of chain[i].edges) {
      const p = e.pointAt(0.5);
      for (const g of byEdge.get(e.hashCode) ?? []) {
        if (seen.has(g.hashCode)) continue;
        const n1 = chain[i].normalAt(p);
        const n2 = g.normalAt(p);
        if (n1.x * n2.x + n1.y * n2.y + n1.z * n2.z > 0.995 && facesDir(g)) {
          seen.add(g.hashCode);
          chain.push(g);
        }
      }
    }
  }
  return chain;
}

/** Тело, «заметаемое» гранью (и её касательной цепочкой) при сдвиге вдоль нормали */
export function facePrism(s: Shape, faceId: number, distance: number): Shape {
  const f = findFace(s, faceId);
  const n = f.normalAt();
  const vec = scale([n.x, n.y, n.z], distance);
  const prisms = tangentChain(s, f).map((x) => basicFaceExtrusion(x, new Vector(vec)) as Shape);
  return prisms.slice(1).reduce((acc, p) => acc.fuse(p), prisms[0]);
}

/** Тяни-толкай: «+» наращивает материал от грани, «−» срезает внутрь */
export function pushPull(s: Shape, faceId: number, distance: number): Shape {
  const prism = facePrism(s, faceId, distance);
  return distance > 0 ? s.clone().fuse(prism) : s.clone().cut(prism);
}

/**
 * Полое тело с толщиной стенки; выбранные грани удаляются (открытые).
 * Вызываем OpenCascade напрямую: shell() из replicad не проверяет успех и на
 * сложных телах (скругления) молча возвращает исходную форму. Пробуем два способа
 * сопряжения стенок — «дугами» и «пересечением».
 */
export function shell(s: Shape, faceIds: number[], thickness: number): Shape {
  const oc = getOC();
  const faces = s.faces.filter((f) => faceIds.includes(f.hashCode));
  for (const join of [oc.GeomAbs_JoinType.GeomAbs_Arc, oc.GeomAbs_JoinType.GeomAbs_Intersection]) {
    const list = new oc.NCollection_List_TopoDS_Shape();
    const builder = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      for (const f of faces) list.Append(f.wrapped);
      builder.MakeThickSolidByJoin(s.wrapped, list, -thickness, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, join, false);
      if (!builder.IsDone()) continue;
      const result = cast(builder.Shape()) as Shape;
      // Успешная оболочка всегда добавляет внутренние грани
      if (result.faces.length > s.faces.length) return result;
    } catch {
      // OpenCascade бросает исключение на неудачной геометрии — пробуем следующий способ
    } finally {
      list.delete();
      builder.delete();
    }
  }
  throw new Error("Не удалось построить оболочку");
}

export function mesh(s: Shape): MeshData {
  const m = s.mesh({ tolerance: 0.05, angularTolerance: 0.2 });
  const e = s.meshEdges({ tolerance: 0.05, angularTolerance: 0.2 });
  return {
    vertices: Float32Array.from(m.vertices),
    normals: Float32Array.from(m.normals),
    triangles: Uint32Array.from(m.triangles),
    edges: Float32Array.from(e.lines),
    faceGroups: m.faceGroups,
    edgeGroups: e.edgeGroups,
  };
}

/** Скругление выбранных углов контура: радиусы группируем, каждый — одним вызовом ядра */
function filletCorners(d: Drawing, pts: V2[], radii?: number[]): Drawing {
  const byRadius = new Map<number, V2[]>();
  radii?.forEach((r, i) => r > 0 && byRadius.set(r, [...(byRadius.get(r) ?? []), pts[i]]));
  for (const [r, list] of byRadius) d = d.fillet(r, (c) => c.inList(list));
  return d;
}

function profileDrawing(p: Profile): Drawing {
  switch (p.kind) {
    case "rect":
      return filletCorners(drawRectangle(p.w, p.h).translate(p.x + p.w / 2, p.y + p.h / 2), corners(p), p.radii);
    case "circle":
      return drawCircle(p.r).translate(p.cx, p.cy);
    case "ellipse": {
      // Большая полуось ядра — вдоль X; для «высокого» эллипса поворачиваем
      const e = p.rx >= p.ry ? drawEllipse(p.rx, p.ry) : drawEllipse(p.ry, p.rx).rotate(90);
      return e.translate(p.cx, p.cy);
    }
    case "slot": {
      const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
      if (len < 1e-9) return drawCircle(p.r).translate(p.a[0], p.a[1]);
      const d: V2 = [(p.b[0] - p.a[0]) / len, (p.b[1] - p.a[1]) / len];
      const n: V2 = [-d[1] * p.r, d[0] * p.r];
      const at = (c: V2, k: V2, s = 1): V2 => [c[0] + k[0] * s, c[1] + k[1] * s];
      return draw(at(p.a, n))
        .lineTo(at(p.b, n))
        .threePointsArcTo(at(p.b, n, -1), at(p.b, d, p.r))
        .lineTo(at(p.a, n, -1))
        .threePointsArcTo(at(p.a, n), at(p.a, d, -p.r))
        .close();
    }
    case "poly": {
      let pen = draw(p.pts[0]);
      for (const q of p.pts.slice(1)) pen = pen.lineTo(q);
      return filletCorners(pen.close(), p.pts, p.radii);
    }
  }
}

/** Середина ребра и направление «внутрь» тела (биссектриса против нормалей смежных граней) */
export function edgeFrame(s: Shape, edgeId: number): { mid: Vec3; dir: Vec3 } {
  const e = s.edges.find((x) => x.hashCode === edgeId);
  if (!e) throw new Error("Ребро не найдено");
  const p = e.pointAt(0.5);
  const n = [0, 0, 0] as Vec3;
  for (const f of s.faces) {
    if (!f.edges.some((x) => x.hashCode === edgeId)) continue;
    const m = f.normalAt(p);
    n[0] += m.x;
    n[1] += m.y;
    n[2] += m.z;
  }
  const len = Math.hypot(...n) || 1;
  return { mid: [p.x, p.y, p.z], dir: [-n[0] / len, -n[1] / len, -n[2] / len] };
}

/** Равномерный масштаб относительно точки */
export const scaleUniform = (s: Shape, k: number, center: Vec3): Shape => s.clone().scale(k, center);

/** Поворот на угол (градусы) вокруг оси, проходящей через точку */
export const rotate = (s: Shape, angle: number, center: Vec3, axis: Vec3): Shape => s.clone().rotate(angle, center, axis);

/**
 * Вытянуть профиль вдоль нормали плоскости; отрицательное расстояние — в обратную сторону.
 * symmetric — на distance в обе стороны от плоскости эскиза (всего 2·distance).
 */
export function extrudeProfile(plane: SketchPlane, p: Profile, distance: number, symmetric = false): Shape {
  const d = Math.abs(distance);
  if (symmetric) {
    // Сдвигаем плоскость назад на d и вытягиваем на 2d вперёд
    const origin: Vec3 = [plane.origin[0] - plane.normal[0] * d, plane.origin[1] - plane.normal[1] * d, plane.origin[2] - plane.normal[2] * d];
    const pl = new Plane(origin, plane.xDir, plane.normal);
    return profileDrawing(p).sketchOnPlane(pl).extrude(2 * d, { extrusionDirection: plane.normal }) as Shape;
  }
  const pl = new Plane(plane.origin, plane.xDir, plane.normal);
  const dir = scale(plane.normal, Math.sign(distance) || 1);
  return profileDrawing(p).sketchOnPlane(pl).extrude(d, { extrusionDirection: dir }) as Shape;
}

/** Вершины тела (концы рёбер) — для плоскости по трём точкам */
export function vertices(s: Shape): Vec3[] {
  const out: Vec3[] = [];
  for (const e of s.edges) {
    for (const t of [0, 1]) {
      const p = e.pointAt(t);
      const v: Vec3 = [p.x, p.y, p.z];
      if (!out.some((q) => Math.hypot(q[0] - v[0], q[1] - v[1], q[2] - v[2]) < 1e-6)) out.push(v);
    }
  }
  return out;
}

/** Концы ребра — ось для плоскости «под углом» */
export function edgeEnds(s: Shape, edgeId: number): [Vec3, Vec3] {
  const e = s.edges.find((x) => x.hashCode === edgeId);
  if (!e) throw new Error("Ребро не найдено");
  const a = e.pointAt(0);
  const b = e.pointAt(1);
  return [
    [a.x, a.y, a.z],
    [b.x, b.y, b.z],
  ];
}

/** Плоскость эскиза на грани тела (только для плоских граней) */
export function facePlane(s: Shape, faceId: number): SketchPlane | null {
  const face = s.faces.find((f) => f.hashCode === faceId);
  if (!face || face.geomType !== "PLANE") return null;
  const n = face.normalAt();
  const c = face.center;
  return planeFrom([c.x, c.y, c.z], [n.x, n.y, n.z]);
}

/** Точная геометрия в текстовом формате BREP (OpenCascade) — для сохранения проекта */
export const toBrep = (s: Shape): string => s.serialize();
export const fromBrep = (data: string): Shape => deserializeShape(data) as Shape;

/** Импорт STEP/STL; несколько тел в файле разбиваются на отдельные */
export async function importFile(file: File): Promise<Shape[]> {
  const ext = file.name.split(".").pop()!.toLowerCase();
  const shape = ext === "stl" ? await importSTL(file) : await importSTEP(file);
  const solids = (shape as Shape).solids ?? [];
  return solids.length > 1 ? (solids as Shape[]) : [shape as Shape];
}

function combined(shapes: Shape[]): AnyShape {
  return shapes.length === 1 ? shapes[0] : makeCompound(shapes);
}

export function exportSTL(shapes: Shape[]): Blob {
  return combined(shapes).blobSTL({ binary: true, tolerance: 0.02, angularTolerance: 0.1 });
}

export function exportSTEPFile(items: { shape: Shape; name: string }[]): Blob {
  return exportSTEP(items.map((i) => ({ shape: i.shape, name: i.name })));
}
