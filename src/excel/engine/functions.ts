// @ts-nocheck -- strict index checks relaxed for engine; covered by engine.test.ts
import type { Node } from "./parser";
import { dateToSerial, formatValue, nowSerial, serialToDate } from "./format";
import {
  E,
  XErr,
  compare,
  isMatrix,
  parseNumText,
  toBool,
  toMatrix,
  toNum,
  toStr,
  type Matrix,
  type Scalar,
  type Value,
} from "./values";

export interface Arg {
  node: Node;
  isRef: boolean;
  get: () => Value;
}

export type Fn = (args: Arg[]) => Value;

const scalarOf = (v: Value): Scalar => {
  if (isMatrix(v)) {
    if (v.length === 1 && v[0].length === 1) return v[0][0];
    return v[0]?.[0] ?? null;
  }
  return v;
};
const num = (a: Arg | undefined, def?: number): number => {
  if (!a || a.node.k === "empty") {
    if (def === undefined) throw E.value();
    return def;
  }
  return toNum(scalarOf(a.get()));
};
const str = (a: Arg | undefined, def = ""): string => (!a || a.node.k === "empty" ? def : toStr(scalarOf(a.get())));
const bool = (a: Arg | undefined, def: boolean): boolean => (!a || a.node.k === "empty" ? def : toBool(scalarOf(a.get())));
const has = (a: Arg | undefined) => !!a && a.node.k !== "empty";

function argc(args: Arg[], min: number, max = Infinity) {
  if (args.length < min || args.length > max) throw E.value();
}

/** Collect numeric values like SUM does: ranges skip text/bools, direct args coerce. */
function numbers(args: Arg[], ignoreErrors = false): number[] {
  const out: number[] = [];
  for (const a of args) {
    if (a.node.k === "empty") continue;
    let v: Value;
    try {
      v = a.get();
    } catch (e) {
      if (ignoreErrors && e instanceof XErr) continue;
      throw e;
    }
    if (isMatrix(v) || a.isRef) {
      for (const row of toMatrix(v))
        for (const x of row) {
          if (typeof x === "number") out.push(x);
          else if (x instanceof XErr) {
            if (!ignoreErrors) throw x;
          }
        }
    } else {
      if (v === null) continue;
      if (v instanceof XErr) {
        if (ignoreErrors) continue;
        throw v;
      }
      out.push(toNum(v));
    }
  }
  return out;
}

function allValues(args: Arg[]): Scalar[] {
  const out: Scalar[] = [];
  for (const a of args) {
    if (a.node.k === "empty") continue;
    const v = a.get();
    for (const row of toMatrix(v)) for (const x of row) out.push(x);
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const avg = (xs: number[]) => {
  if (!xs.length) throw E.div0();
  return sum(xs) / xs.length;
};
const variance = (xs: number[], sample: boolean) => {
  if (xs.length < (sample ? 2 : 1)) throw E.div0();
  const m = sum(xs) / xs.length;
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - (sample ? 1 : 0));
};
const median = (xs: number[]) => {
  if (!xs.length) throw E.num();
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

function wildcardRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "is");
}

/** Build a predicate from a COUNTIF-style criteria value. */
export function criteria(c: Scalar): (v: Scalar) => boolean {
  if (typeof c === "number") return (v) => typeof v === "number" && v === c || (typeof v === "string" && parseNumText(v) === c);
  if (typeof c === "boolean") return (v) => v === c;
  if (c === null) return (v) => v === null || v === "";
  if (c instanceof XErr) return (v) => v instanceof XErr && v.code === c.code;
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? "=";
  const rhs = m[2];
  const rn = parseNumText(rhs);
  const ru = rhs.toUpperCase();
  const rb = ru === "TRUE" ? true : ru === "FALSE" ? false : null;
  const eq = (v: Scalar): boolean => {
    if (rhs === "") return v === null || v === "";
    if (rn !== null) return typeof v === "number" ? v === rn : typeof v === "string" && parseNumText(v) === rn;
    if (rb !== null) return v === rb;
    if (typeof v !== "string") return false;
    return /[*?~]/.test(rhs) ? wildcardRe(rhs).test(v) : v.toLowerCase() === rhs.toLowerCase();
  };
  if (op === "=") return eq;
  if (op === "<>") return (v) => !eq(v);
  return (v) => {
    if (v === null || v instanceof XErr) return false;
    let cmp: number;
    if (rn !== null) {
      if (typeof v !== "number") return false;
      cmp = v - rn;
    } else {
      if (typeof v !== "string") return false;
      cmp = compare(v, rhs);
    }
    return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
  };
}

function flat(v: Value): Scalar[] {
  return toMatrix(v).flat();
}

function looseEq(a: Scalar, b: Scalar): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function multiIf(args: Arg[], start: number): boolean[] {
  // pairs of (range, criteria) starting at `start`
  let mask: boolean[] | null = null;
  for (let i = start; i + 1 < args.length; i += 2) {
    const vals = flat(args[i].get());
    const pred = criteria(scalarOf(args[i + 1].get()));
    if (mask && mask.length !== vals.length) throw E.value();
    const m: boolean[] = mask ?? vals.map(() => true);
    vals.forEach((v, j) => (m[j] = m[j] && pred(v)));
    mask = m;
  }
  return mask ?? [];
}

function roundHalfAway(x: number, d: number): number {
  const f = Math.pow(10, d);
  const v = Math.abs(x) * f;
  const r = Math.round(v + 1e-9 * Math.max(1, v)) / f;
  return x < 0 ? -r : r;
}

function mapScalar(v: Value, f: (s: Scalar) => Scalar): Value {
  return isMatrix(v) ? v.map((row) => row.map(f)) : f(v);
}

function sortRows(rows: Matrix, keys: { col: Scalar[]; order: number }[]): Matrix {
  const idx = rows.map((_, i) => i);
  idx.sort((a, b) => {
    for (const k of keys) {
      const c = compare(k.col[a] ?? null, k.col[b] ?? null);
      if (c) return c * k.order;
    }
    return a - b;
  });
  return idx.map((i) => rows[i]);
}

const transpose = (m: Matrix): Matrix => (m[0] ?? []).map((_, c) => m.map((r) => r[c]));

function aggregateBy(code: number, xs: number[], all: Scalar[]): number {
  switch (code) {
    case 1:
      return avg(xs);
    case 2:
      return xs.length;
    case 3:
      return all.filter((x) => x !== null && x !== "").length;
    case 4:
      return xs.length ? Math.max(...xs) : 0;
    case 5:
      return xs.length ? Math.min(...xs) : 0;
    case 6:
      return xs.reduce((p, x) => p * x, 1);
    case 7:
      return Math.sqrt(variance(xs, true));
    case 8:
      return Math.sqrt(variance(xs, false));
    case 9:
      return sum(xs);
    case 10:
      return variance(xs, true);
    case 11:
      return variance(xs, false);
    case 12:
      return median(xs);
  }
  throw E.value();
}

function lookupIndex(needle: Scalar, hay: Scalar[], mode: number, wildcard = false): number {
  if (mode === 0 || wildcard) {
    if (wildcard && typeof needle === "string") {
      const re = wildcardRe(needle);
      return hay.findIndex((h) => typeof h === "string" && re.test(h));
    }
    return hay.findIndex((h) => looseEq(h, needle) || (typeof needle === "number" && h === needle));
  }
  let best = -1;
  for (let i = 0; i < hay.length; i++) {
    const h = hay[i];
    if (h === null || h instanceof XErr || typeof h !== typeof needle) continue;
    const c = compare(h, needle);
    if (c === 0) return i;
    if (mode === 1 ? c < 0 : c > 0) {
      if (best < 0 || (mode === 1 ? compare(h, hay[best]) > 0 : compare(h, hay[best]) < 0)) best = i;
    }
  }
  return best;
}

export const FUNCTIONS: Record<string, Fn> = {
  SUM: (a) => sum(numbers(a)),
  AVERAGE: (a) => avg(numbers(a)),
  COUNT: (a) => {
    let n = 0;
    for (const x of a) {
      if (x.node.k === "empty") continue;
      const v = x.get();
      if (isMatrix(v) || x.isRef) n += flat(v).filter((y) => typeof y === "number").length;
      else if (typeof v === "number" || (typeof v === "string" && parseNumText(v) !== null) || typeof v === "boolean") n++;
    }
    return n;
  },
  COUNTA: (a) => allValues(a).filter((x) => x !== null).length,
  COUNTBLANK: (a) => allValues(a).filter((x) => x === null || x === "").length,
  MAX: (a) => {
    const xs = numbers(a);
    return xs.length ? Math.max(...xs) : 0;
  },
  MIN: (a) => {
    const xs = numbers(a);
    return xs.length ? Math.min(...xs) : 0;
  },
  MEDIAN: (a) => median(numbers(a)),
  PRODUCT: (a) => {
    const xs = numbers(a);
    return xs.length ? xs.reduce((p, x) => p * x, 1) : 0;
  },
  STDEV: (a) => Math.sqrt(variance(numbers(a), true)),
  VAR: (a) => variance(numbers(a), true),
  IF: (a) => {
    argc(a, 1, 3);
    const c = a[0].get();
    const t = () => (has(a[1]) ? a[1].get() : 0);
    const f = () => (a.length > 2 ? (has(a[2]) ? a[2].get() : 0) : false);
    if (isMatrix(c)) {
      const tv = toMatrix(t());
      const fv = toMatrix(f());
      return c.map((row, i) =>
        row.map((x, j) => {
          if (x instanceof XErr) return x;
          const pick = toBool(x) ? tv : fv;
          return pick.length === 1 && pick[0].length === 1 ? pick[0][0] : (pick[i]?.[j] ?? E.na());
        }),
      );
    }
    return toBool(c) ? t() : f();
  },
  IFS: (a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (toBool(scalarOf(a[i].get()))) return a[i + 1].get();
    return E.na();
  },
  AND: (a) => {
    const vs = allValues(a).filter((x) => x !== null && typeof x !== "string");
    if (!vs.length) return E.value();
    return vs.every((x) => toBool(x));
  },
  OR: (a) => {
    const vs = allValues(a).filter((x) => x !== null && typeof x !== "string");
    if (!vs.length) return E.value();
    return vs.some((x) => toBool(x));
  },
  XOR: (a) => allValues(a).filter((x) => x !== null && typeof x !== "string" && toBool(x)).length % 2 === 1,
  NOT: (a) => {
    argc(a, 1, 1);
    return mapScalar(a[0].get(), (x) => !toBool(x));
  },
  TRUE: () => true,
  FALSE: () => false,
  IFERROR: (a) => {
    argc(a, 2, 2);
    try {
      const v = a[0].get();
      if (isMatrix(v)) return v.map((r) => r.map((x) => (x instanceof XErr ? scalarOf(a[1].get()) : x)));
      return v instanceof XErr ? a[1].get() : v;
    } catch (e) {
      if (e instanceof XErr) return a[1].get();
      throw e;
    }
  },
  IFNA: (a) => {
    try {
      const v = a[0].get();
      return v instanceof XErr && v.code === "#N/A" ? a[1].get() : v;
    } catch (e) {
      if (e instanceof XErr && e.code === "#N/A") return a[1].get();
      throw e;
    }
  },
  ISBLANK: (a) => scalarOf(a[0].get()) === null,
  ISNUMBER: (a) => typeof scalarOf(a[0].get()) === "number",
  ISTEXT: (a) => typeof scalarOf(a[0].get()) === "string",
  ISERROR: (a) => {
    try {
      return scalarOf(a[0].get()) instanceof XErr;
    } catch {
      return true;
    }
  },
  NA: () => E.na(),
  SUMIF: (a) => {
    argc(a, 2, 3);
    const vals = flat(a[0].get());
    const pred = criteria(scalarOf(a[1].get()));
    const sums = a[2] ? flat(a[2].get()) : vals;
    let s = 0;
    vals.forEach((v, i) => {
      const x = sums[i];
      if (pred(v) && typeof x === "number") s += x;
    });
    return s;
  },
  SUMIFS: (a) => {
    const sums = flat(a[0].get());
    const mask = multiIf(a, 1);
    return sums.reduce<number>((s, x, i) => (mask[i] && typeof x === "number" ? s + x : s), 0);
  },
  AVERAGEIF: (a) => {
    const vals = flat(a[0].get());
    const pred = criteria(scalarOf(a[1].get()));
    const src = a[2] ? flat(a[2].get()) : vals;
    const xs = vals.map((v, i) => (pred(v) ? src[i] : null)).filter((x): x is number => typeof x === "number");
    return avg(xs);
  },
  COUNTIF: (a) => {
    argc(a, 2, 2);
    const pred = criteria(scalarOf(a[1].get()));
    return flat(a[0].get()).filter(pred).length;
  },
  COUNTIFS: (a) => multiIf(a, 0).filter(Boolean).length,
  VLOOKUP: (a) => {
    argc(a, 3, 4);
    const needle = scalarOf(a[0].get());
    const table = toMatrix(a[1].get());
    const col = Math.trunc(num(a[2]));
    const approx = bool(a[3], true);
    if (col < 1) throw E.value();
    if (col > (table[0]?.length ?? 0)) throw E.ref();
    const i = lookupIndex(needle, table.map((r) => r[0]), approx ? 1 : 0, !approx && typeof needle === "string" && /[*?]/.test(needle));
    if (i < 0) return E.na();
    return table[i][col - 1];
  },
  HLOOKUP: (a) => {
    argc(a, 3, 4);
    const needle = scalarOf(a[0].get());
    const table = toMatrix(a[1].get());
    const row = Math.trunc(num(a[2]));
    const approx = bool(a[3], true);
    if (row < 1) throw E.value();
    if (row > table.length) throw E.ref();
    const i = lookupIndex(needle, table[0], approx ? 1 : 0);
    if (i < 0) return E.na();
    return table[row - 1][i];
  },
  XLOOKUP: (a) => {
    argc(a, 3, 6);
    const needle = scalarOf(a[0].get());
    const look = toMatrix(a[1].get());
    const ret = toMatrix(a[2].get());
    const matchMode = has(a[4]) ? num(a[4]) : 0;
    const searchMode = has(a[5]) ? num(a[5]) : 1;
    const vertical = look[0].length === 1;
    let hay = vertical ? look.map((r) => r[0]) : look[0];
    const rev = searchMode === -1;
    if (rev) hay = [...hay].reverse();
    let i = lookupIndex(needle, hay, matchMode === 2 ? 0 : matchMode === -1 ? 1 : matchMode === 1 ? -1 : 0, matchMode === 2);
    if (i >= 0 && rev) i = hay.length - 1 - i;
    if (i < 0) return has(a[3]) ? a[3].get() : E.na();
    if (vertical) {
      const row = ret[i];
      if (!row) throw E.value();
      return row.length === 1 ? row[0] : [row];
    }
    const col = ret.map((r) => r[i]);
    return col.length === 1 ? col[0] : col.map((x) => [x]);
  },
  MATCH: (a) => {
    argc(a, 2, 3);
    const needle = scalarOf(a[0].get());
    const hay = flat(a[1].get());
    const type = has(a[2]) ? num(a[2]) : 1;
    const i = lookupIndex(needle, hay, type === 0 ? 0 : type > 0 ? 1 : -1, type === 0 && typeof needle === "string" && /[*?]/.test(needle));
    return i < 0 ? E.na() : i + 1;
  },
  INDEX: (a) => {
    argc(a, 2, 3);
    const m = toMatrix(a[0].get());
    let r = Math.trunc(num(a[1], 0));
    let c = has(a[2]) ? Math.trunc(num(a[2])) : 0;
    if (!has(a[2]) && m.length === 1) {
      c = r;
      r = 1;
    }
    if (r < 0 || c < 0 || r > m.length || c > (m[0]?.length ?? 0)) throw E.ref();
    if (r === 0 && c === 0) return m;
    if (r === 0) return m.map((row) => [row[c - 1]]);
    if (c === 0) return m[0].length === 1 ? m[r - 1][0] : [m[r - 1]];
    return m[r - 1][c - 1];
  },
  ROWS: (a) => toMatrix(a[0].get()).length,
  COLUMNS: (a) => toMatrix(a[0].get())[0]?.length ?? 0,
  FILTER: (a) => {
    argc(a, 2, 3);
    const m = toMatrix(a[0].get());
    const inc = toMatrix(a[1].get());
    let out: Matrix;
    if (inc.length === m.length && inc[0].length === 1) out = m.filter((_, i) => toBool(inc[i][0]));
    else if (inc.length === 1 && inc[0].length === m[0].length) {
      const keep = inc[0].map((x) => toBool(x));
      out = m.map((r) => r.filter((_, j) => keep[j]));
      if (!out[0]?.length) out = [];
    } else throw E.value();
    if (!out.length) return has(a[2]) ? a[2].get() : E.calc();
    return out;
  },
  SORT: (a) => {
    argc(a, 1, 4);
    let m = toMatrix(a[0].get());
    const idx = has(a[1]) ? Math.trunc(num(a[1])) : 1;
    const order = has(a[2]) ? num(a[2]) : 1;
    const byCol = bool(a[3], false);
    if (byCol) m = transpose(m);
    if (idx < 1 || idx > (m[0]?.length ?? 0)) throw E.value();
    let out = sortRows(m, [{ col: m.map((r) => r[idx - 1]), order: order < 0 ? -1 : 1 }]);
    if (byCol) out = transpose(out);
    return out;
  },
  SORTBY: (a) => {
    const m = toMatrix(a[0].get());
    const keys: { col: Scalar[]; order: number }[] = [];
    for (let i = 1; i < a.length; i += 2) {
      const col = flat(a[i].get());
      if (col.length !== m.length) throw E.value();
      keys.push({ col, order: has(a[i + 1]) && num(a[i + 1]) < 0 ? -1 : 1 });
    }
    return sortRows(m, keys);
  },
  UNIQUE: (a) => {
    let m = toMatrix(a[0].get());
    const byCol = bool(a[1], false);
    const once = bool(a[2], false);
    if (byCol) m = transpose(m);
    const keyOf = (r: Scalar[]) => JSON.stringify(r.map((x) => (typeof x === "string" ? x.toLowerCase() : x instanceof XErr ? x.code : x)));
    const counts = new Map<string, number>();
    m.forEach((r) => counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1));
    const seen = new Set<string>();
    let out = m.filter((r) => {
      const k = keyOf(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return !once || counts.get(k) === 1;
    });
    if (!out.length) return E.calc();
    if (byCol) out = transpose(out);
    return out;
  },
  SEQUENCE: (a) => {
    const rows = Math.trunc(num(a[0]));
    const cols = has(a[1]) ? Math.trunc(num(a[1])) : 1;
    const start = has(a[2]) ? num(a[2]) : 1;
    const step = has(a[3]) ? num(a[3]) : 1;
    if (rows < 1 || cols < 1 || rows * cols > 1e6) throw E.calc();
    return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => start + (r * cols + c) * step));
  },
  TRANSPOSE: (a) => transpose(toMatrix(a[0].get())),
  LEFT: (a) => str(a[0]).slice(0, has(a[1]) ? Math.max(0, num(a[1])) : 1),
  RIGHT: (a) => {
    const s = str(a[0]);
    const n = has(a[1]) ? Math.max(0, num(a[1])) : 1;
    return n === 0 ? "" : s.slice(-n);
  },
  MID: (a) => {
    argc(a, 3, 3);
    const start = num(a[1]);
    if (start < 1) throw E.value();
    return str(a[0]).substr(start - 1, Math.max(0, num(a[2])));
  },
  LEN: (a) => str(a[0]).length,
  TRIM: (a) => str(a[0]).replace(/ +/g, " ").trim(),
  UPPER: (a) => str(a[0]).toUpperCase(),
  LOWER: (a) => str(a[0]).toLowerCase(),
  PROPER: (a) => str(a[0]).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()),
  CONCAT: (a) => allValues(a).map(toStr).join(""),
  CONCATENATE: (a) => a.map((x) => str(x)).join(""),
  TEXTJOIN: (a) => {
    const delim = str(a[0]);
    const ignore = bool(a[1], true);
    return allValues(a.slice(2))
      .map(toStr)
      .filter((s) => !ignore || s !== "")
      .join(delim);
  },
  TEXT: (a) => formatValue(scalarOf(a[0].get()), str(a[1])).text,
  VALUE: (a) => toNum(scalarOf(a[0].get())),
  REPT: (a) => str(a[0]).repeat(Math.max(0, num(a[1]))),
  SUBSTITUTE: (a) => str(a[0]).split(str(a[1])).join(str(a[2])),
  FIND: (a) => {
    const i = str(a[1]).indexOf(str(a[0]), (has(a[2]) ? num(a[2]) : 1) - 1);
    return i < 0 ? E.value() : i + 1;
  },
  TODAY: () => Math.floor(nowSerial()),
  NOW: () => nowSerial(),
  DATE: (a) => {
    argc(a, 3, 3);
    let y = Math.trunc(num(a[0]));
    if (y < 1900) y += 1900;
    const d = new Date(Date.UTC(y, Math.trunc(num(a[1])) - 1, Math.trunc(num(a[2]))));
    return dateToSerial(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  },
  YEAR: (a) => serialToDate(num(a[0])).getUTCFullYear(),
  MONTH: (a) => serialToDate(num(a[0])).getUTCMonth() + 1,
  DAY: (a) => serialToDate(num(a[0])).getUTCDate(),
  WEEKDAY: (a) => serialToDate(num(a[0])).getUTCDay() + 1,
  ROUND: (a) => roundHalfAway(num(a[0]), Math.trunc(num(a[1], 0))),
  ROUNDUP: (a) => {
    const x = num(a[0]);
    const f = Math.pow(10, Math.trunc(num(a[1], 0)));
    const v = Math.ceil(Number((Math.abs(x) * f).toPrecision(15))) / f;
    return x < 0 ? -v : v;
  },
  ROUNDDOWN: (a) => {
    const x = num(a[0]);
    const f = Math.pow(10, Math.trunc(num(a[1], 0)));
    const v = Math.floor(Number((Math.abs(x) * f).toPrecision(15))) / f;
    return x < 0 ? -v : v;
  },
  INT: (a) => Math.floor(num(a[0])),
  ABS: (a) => Math.abs(num(a[0])),
  SQRT: (a) => {
    const x = num(a[0]);
    if (x < 0) throw E.num();
    return Math.sqrt(x);
  },
  POWER: (a) => Math.pow(num(a[0]), num(a[1])),
  PI: () => Math.PI,
  RAND: () => Math.random(),
  MOD: (a) => {
    const n = num(a[0]);
    const d = num(a[1]);
    if (d === 0) throw E.div0();
    return n - d * Math.floor(n / d);
  },
  SUBTOTAL: (a) => {
    const code = Math.trunc(num(a[0])) % 100;
    const rest = a.slice(1);
    return aggregateBy(code, numbers(rest), allValues(rest));
  },
  AGGREGATE: (a) => {
    const code = Math.trunc(num(a[0]));
    const opt = Math.trunc(num(a[1], 0));
    const rest = a.slice(2);
    const ignoreErr = [2, 3, 6, 7].includes(opt);
    const xs = numbers(rest, ignoreErr);
    const all = ignoreErr ? allValues(rest).filter((x) => !(x instanceof XErr)) : allValues(rest);
    return aggregateBy(code, xs, all);
  },
};

export const FUNCTION_CATEGORIES: Record<string, string[]> = {
  financial: [],
  logical: ["IF", "IFS", "AND", "OR", "NOT", "XOR", "IFERROR", "IFNA", "TRUE", "FALSE"],
  text: ["LEFT", "RIGHT", "MID", "LEN", "TRIM", "UPPER", "LOWER", "PROPER", "CONCAT", "CONCATENATE", "TEXTJOIN", "TEXT", "VALUE", "REPT", "SUBSTITUTE", "FIND"],
  date: ["TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "WEEKDAY"],
  lookup: ["VLOOKUP", "HLOOKUP", "XLOOKUP", "INDEX", "MATCH", "FILTER", "SORT", "SORTBY", "UNIQUE", "SEQUENCE", "TRANSPOSE", "ROWS", "COLUMNS"],
  math: ["SUM", "SUMIF", "SUMIFS", "PRODUCT", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "ABS", "SQRT", "POWER", "PI", "RAND", "MOD", "SUBTOTAL", "AGGREGATE"],
  stats: ["AVERAGE", "AVERAGEIF", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF", "COUNTIFS", "MAX", "MIN", "MEDIAN", "STDEV", "VAR"],
  info: ["ISBLANK", "ISNUMBER", "ISTEXT", "ISERROR", "NA"],
};
delete FUNCTION_CATEGORIES.financial;
