// Формат файла проекта (.remeslo, ранее .tabcad): JSON с точной геометрией тел в BREP и эскизами.
import type { Body, Doc, RefPlane, Sketch } from "./doc";
import { fromBrep, toBrep } from "./kernel";

// Внутренняя метка формата — прежняя, чтобы открывались старые файлы
const FORMAT = "tabcad";
const VERSION = 1;

interface FileBody extends Omit<Body, "shape"> {
  brep: string;
}

interface ProjectFile {
  format: typeof FORMAT;
  version: number;
  name: string;
  nextId: number;
  bodies: FileBody[];
  sketches: Sketch[];
  planes?: RefPlane[];
}

// Тела неизменяемы — BREP одного и того же тела считаем один раз
// (автосохранение срабатывает после каждого действия)
const brepCache = new WeakMap<Body, string>();

function brepOf(b: Body) {
  let s = brepCache.get(b);
  if (s === undefined) {
    s = toBrep(b.shape);
    brepCache.set(b, s);
  }
  return s;
}

export function serialize(doc: Doc, name: string): string {
  const file: ProjectFile = {
    format: FORMAT,
    version: VERSION,
    name,
    nextId: doc.idCounter,
    bodies: doc.bodies.map((b) => {
      const { shape: _, ...rest } = b;
      return { ...rest, brep: brepOf(b) };
    }),
    sketches: doc.sketches,
    planes: doc.planes,
  };
  return JSON.stringify(file);
}

export function deserialize(json: string): { name: string; nextId: number; bodies: Body[]; sketches: Sketch[]; planes: RefPlane[] } {
  const file = JSON.parse(json) as ProjectFile;
  if (file.format !== FORMAT) throw new Error("Это не файл проекта CAD.remeslo");
  if (file.version > VERSION) throw new Error("Файл создан более новой версией приложения");
  const bodies = file.bodies.map(({ brep, ...rest }) => {
    const body: Body = { ...rest, shape: fromBrep(brep) };
    brepCache.set(body, brep);
    return body;
  });
  return { name: file.name, nextId: file.nextId, bodies, sketches: file.sketches ?? [], planes: file.planes ?? [] };
}
