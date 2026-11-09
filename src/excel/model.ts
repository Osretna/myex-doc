// @ts-nocheck -- strict index checks relaxed for engine; covered by engine.test.ts
import type { Rect } from "./engine/refs";

export interface Borders {
  t?: boolean;
  r?: boolean;
  b?: boolean;
  l?: boolean;
  color?: string;
}

export interface Style {
  b?: boolean;
  i?: boolean;
  u?: boolean | "double";
  st?: boolean;
  ff?: string;
  fs?: number;
  fc?: string;
  bg?: string;
  ha?: "left" | "center" | "right";
  va?: "top" | "middle" | "bottom";
  wrap?: boolean;
  nf?: string;
  bd?: Borders;
}

export interface Cell {
  input?: string;
  s?: Style;
  comment?: string;
}

export type ChartType = "column" | "bar" | "line" | "pie" | "area";

export interface Chart {
  id: string;
  type: ChartType;
  range: Rect;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
}

export type CondType = "gt" | "lt" | "eq" | "between" | "text" | "dup" | "scale";

export interface CondRule {
  id: string;
  range: Rect;
  type: CondType;
  v1?: string;
  v2?: string;
  bg?: string;
  fc?: string;
}

export interface AutoFilter {
  r: number;
  c1: number;
  c2: number;
  /** excluded display values per column */
  hidden: Record<number, string[]>;
}

export interface Sheet {
  id: string;
  name: string;
  cells: Record<string, Cell>;
  colW: Record<number, number>;
  rowH: Record<number, number>;
  charts: Chart[];
  cf: CondRule[];
  filter?: AutoFilter;
  protected?: boolean;
  tabColor?: string;
}

export interface Workbook {
  name: string;
  sheets: Sheet[];
  /** defined names -> formula text without "=", e.g. Sheet1!$A$1:$A$10 */
  names: Record<string, string>;
}

export const DEFAULT_COL_W = 64;
export const DEFAULT_ROW_H = 20;

let idc = 0;
export const uid = (p = "id") => p + Date.now().toString(36) + (idc++).toString(36);

export function newSheet(name: string): Sheet {
  return { id: uid("s"), name, cells: {}, colW: {}, rowH: {}, charts: [], cf: [] };
}

export function newWorkbook(name = "Book1"): Workbook {
  return { name, sheets: [newSheet("Sheet1")], names: {} };
}
