// @ts-nocheck -- strict index checks relaxed for engine; covered by engine.test.ts
import { MAX_COLS, MAX_ROWS, quoteSheet } from "./refs";
import { refPartText, tokenize, type RefPart, type Tok } from "./tokenizer";

type RefTok = Extract<Tok, { t: "ref" }>;

function rebuild(input: string, fn: (t: RefTok) => string | null): string {
  if (!input.startsWith("=")) return input;
  const body = input.slice(1);
  let toks: Tok[];
  try {
    toks = tokenize(body);
  } catch {
    return input;
  }
  let out = "";
  let pos = 0;
  for (const t of toks) {
    if (t.t !== "ref") continue;
    const rep = fn(t);
    if (rep === null) continue;
    out += body.slice(pos, t.s) + rep;
    pos = t.e;
  }
  return "=" + out + body.slice(pos);
}

function refText(sheet: string | undefined, a: RefPart, b?: RefPart): string {
  const p = sheet ? quoteSheet(sheet) + "!" : "";
  return p + refPartText(a) + (b ? ":" + refPartText(b) : "");
}

/** Shift relative references when copying a formula by (dr, dc). */
export function shiftFormula(input: string, dr: number, dc: number): string {
  if (!dr && !dc) return input;
  return rebuild(input, (t) => {
    const mv = (p: RefPart): RefPart | null => {
      const r = p.r < 0 || p.ar ? p.r : p.r + dr;
      const c = p.c < 0 || p.ac ? p.c : p.c + dc;
      if ((p.r >= 0 && (r < 0 || r >= MAX_ROWS)) || (p.c >= 0 && (c < 0 || c >= MAX_COLS))) return null;
      return { ...p, r, c };
    };
    const a = mv(t.a);
    const b = t.b ? mv(t.b) : undefined;
    if (!a || b === null) return (t.sheet ? quoteSheet(t.sheet) + "!" : "") + "#REF!";
    return refText(t.sheet, a, b ?? undefined);
  });
}

/**
 * Adjust references after inserting (count > 0) or deleting (count < 0) rows/cols
 * at index `at` on sheet `target`. `formulaSheet` is the sheet holding the formula.
 */
export function adjustForStructure(
  input: string,
  formulaSheet: string,
  target: string,
  axis: "row" | "col",
  at: number,
  count: number,
): string {
  return rebuild(input, (t) => {
    const sheet = t.sheet ?? formulaSheet;
    if (sheet.toLowerCase() !== target.toLowerCase()) return null;
    const get = (p: RefPart) => (axis === "row" ? p.r : p.c);
    const set = (p: RefPart, v: number): RefPart => (axis === "row" ? { ...p, r: v } : { ...p, c: v });
    if (get(t.a) < 0) return null; // whole column/row in the other axis
    const prefix = t.sheet ? quoteSheet(t.sheet) + "!" : "";
    if (count > 0) {
      const sh = (p: RefPart) => (get(p) >= at ? set(p, get(p) + count) : p);
      return refText(t.sheet, sh(t.a), t.b ? sh(t.b) : undefined);
    }
    const n = -count;
    const end = at + n;
    if (!t.b) {
      const v = get(t.a);
      if (v >= at && v < end) return prefix + "#REF!";
      return refText(t.sheet, v >= end ? set(t.a, v - n) : t.a);
    }
    let s = get(t.a);
    let e = get(t.b);
    if (s >= at && e < end) return prefix + "#REF!";
    if (s >= end) s -= n;
    else if (s >= at) s = at;
    if (e >= end) e -= n;
    else if (e >= at) e = at - 1;
    return refText(t.sheet, set(t.a, s), set(t.b, e));
  });
}

export function renameSheetRefs(input: string, oldName: string, newName: string): string {
  return rebuild(input, (t) =>
    t.sheet && t.sheet.toLowerCase() === oldName.toLowerCase() ? refText(newName, t.a, t.b) : null,
  );
}

/** Cycle the reference before `caret` through $A$1 → A$1 → $A1 → A1 (F4). */
export function cycleAbsolute(text: string, caret: number): { text: string; caret: number } {
  if (!text.startsWith("=")) return { text, caret };
  let toks: Tok[];
  try {
    toks = tokenize(text.slice(1));
  } catch {
    return { text, caret };
  }
  const t = toks.filter((x): x is RefTok => x.t === "ref").find((x) => x.s + 1 <= caret && x.e + 1 >= caret - 0) ??
    toks.filter((x): x is RefTok => x.t === "ref" && x.e + 1 <= caret).pop();
  if (!t) return { text, caret };
  const next = (p: RefPart): RefPart => {
    const state = (p.ac ? 2 : 0) + (p.ar ? 1 : 0); // 0 rel,3 abs,1 row-abs,2 col-abs
    const order = [0, 3, 1, 2];
    const ns = order[(order.indexOf(state) + 1) % 4];
    return { ...p, ac: ns >= 2, ar: ns % 2 === 1 };
  };
  const rep = refText(t.sheet, next(t.a), t.b ? next(t.b) : undefined);
  const nt = text.slice(0, t.s + 1) + rep + text.slice(t.e + 1);
  return { text: nt, caret: t.s + 1 + rep.length };
}
