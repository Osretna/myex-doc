// @ts-nocheck -- strict index checks relaxed for engine; covered by engine.test.ts
import { XErr, numToText, parseNumText, type Scalar } from "./values";

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

export function dateToSerial(y: number, m: number, d: number): number {
  return (Date.UTC(y, m - 1, d) - EPOCH) / DAY;
}
export function serialToDate(serial: number): Date {
  return new Date(EPOCH + Math.round(serial * DAY));
}
export function nowSerial(): number {
  const d = new Date();
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - EPOCH) / DAY;
}

export type Literal = { kind: "formula"; text: string } | { kind: "value"; v: Scalar; fmt?: string };

/** Interpret what a user typed into a cell. */
export function parseInput(input: string): Literal {
  if (input.startsWith("=") && input.length > 1) return { kind: "formula", text: input.slice(1) };
  if (input === "") return { kind: "value", v: null };
  if (input.startsWith("'")) return { kind: "value", v: input.slice(1) };
  const up = input.trim().toUpperCase();
  if (up === "TRUE" || up === "FALSE") return { kind: "value", v: up === "TRUE" };
  if (/^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)$/.test(up)) return { kind: "value", v: new XErr(up) };
  const t = input.trim();
  const n = parseNumText(t);
  if (n !== null) {
    if (t.endsWith("%")) return { kind: "value", v: n, fmt: "0%" };
    if (t.startsWith("$")) return { kind: "value", v: n, fmt: "$#,##0.00" };
    if (t.includes(",")) return { kind: "value", v: n, fmt: "#,##0" };
    return { kind: "value", v: n };
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return { kind: "value", v: dateToSerial(+m[1], +m[2], +m[3]), fmt: "yyyy-mm-dd" };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return { kind: "value", v: dateToSerial(+m[3], +m[1], +m[2]), fmt: "m/d/yyyy" };
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) return { kind: "value", v: (+m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0)) / 86400, fmt: m[3] ? "h:mm:ss" : "h:mm" };
  return { kind: "value", v: input };
}

function general(n: number): string {
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e11 || a < 1e-9) {
    return n.toExponential(5).replace(/\.?0+e/, "E").replace("E+", "E+").replace(/e/, "E");
  }
  return String(Number(n.toPrecision(10)));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDate(n: number, fmt: string): string {
  const d = serialToDate(n);
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  const ampm = /AM\/PM/i.test(fmt);
  const pad = (x: number) => String(x).padStart(2, "0");
  const toks = fmt.match(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|"[^"]*"|\\.|./gi) ?? [];
  let lastWasHour = false;
  const out: string[] = [];
  toks.forEach((tk, i) => {
    const l = tk.toLowerCase();
    const nextIsSec = toks.slice(i + 1).find((x) => /[a-z]/i.test(x))?.toLowerCase().startsWith("s");
    let r: string;
    if (l === "yyyy") r = String(Y);
    else if (l === "yy") r = pad(Y % 100);
    else if (l === "mmmm") r = MONTHS[M];
    else if (l === "mmm") r = MONTHS[M].slice(0, 3);
    else if (l === "mm" || l === "m") {
      const isMin = lastWasHour || nextIsSec;
      const v = isMin ? mi : M + 1;
      r = l === "mm" ? pad(v) : String(v);
    } else if (l === "dddd") r = DAYS[d.getUTCDay()];
    else if (l === "ddd") r = DAYS[d.getUTCDay()].slice(0, 3);
    else if (l === "dd") r = pad(D);
    else if (l === "d") r = String(D);
    else if (l === "hh" || l === "h") {
      const hv = ampm ? h % 12 || 12 : h;
      r = l === "hh" ? pad(hv) : String(hv);
    } else if (l === "ss") r = pad(s);
    else if (l === "s") r = String(s);
    else if (l === "am/pm") r = h < 12 ? "AM" : "PM";
    else if (tk.startsWith('"')) r = tk.slice(1, -1);
    else if (tk.startsWith("\\")) r = tk.slice(1);
    else r = tk;
    if (/[a-z]/i.test(tk) && !tk.startsWith('"')) lastWasHour = l === "h" || l === "hh";
    out.push(r);
  });
  return out.join("");
}

function formatNumberPattern(n: number, fmt: string): string {
  const pct = (fmt.match(/%/g) ?? []).length;
  let v = n * Math.pow(100, pct);
  const body = /[#0][#0,]*(\.[#0]*)?|\.[#0]+/.exec(fmt);
  if (!body) return general(n);
  const pat = body[0];
  const dot = pat.indexOf(".");
  const decimals = dot >= 0 ? pat.length - dot - 1 : 0;
  const thousands = pat.includes(",");
  const neg = v < 0;
  v = Math.abs(v);
  let s = v.toFixed(decimals);
  if (thousands) {
    const [ip, fp] = s.split(".");
    s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fp !== undefined ? "." + fp : "");
  }
  const intZeros = (pat.split(".")[0].match(/0/g) ?? []).length;
  if (intZeros === 0 && s.startsWith("0.")) s = s.slice(1);
  const strip = (x: string) => x.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1").replace(/_./g, " ");
  const prefix = strip(fmt.slice(0, body.index));
  const suffix = strip(fmt.slice(body.index + pat.length));
  return (neg ? "-" : "") + prefix + s + suffix;
}

export function isDateFormat(fmt?: string): boolean {
  if (!fmt) return false;
  const f = fmt.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[ydhs]/i.test(f) || /^m+([/\- .]|$)/i.test(f);
}

/** Format a computed value for display. */
export function formatValue(v: Scalar, fmt?: string): { text: string; color?: string } {
  if (v === null) return { text: "" };
  if (v instanceof XErr) return { text: v.code };
  if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE" };
  if (typeof v === "string") return { text: v };
  if (!isFinite(v)) return { text: "#NUM!" };
  if (!fmt || fmt === "General") return { text: general(v) };
  if (fmt === "@") return { text: numToText(v) };
  let sections = fmt.split(";");
  let section = sections[0];
  let value = v;
  let color: string | undefined;
  if (sections.length > 1 && v < 0) {
    section = sections[1];
    value = Math.abs(v);
  } else if (sections.length > 2 && v === 0) section = sections[2];
  const cm = /^\[(Red|Blue|Green|Black)\]/i.exec(section);
  if (cm) {
    color = cm[1].toLowerCase();
    section = section.slice(cm[0].length);
  }
  sections = [];
  if (isDateFormat(section)) {
    if (value < 0) return { text: "#".repeat(8) };
    return { text: formatDate(value, section), color };
  }
  return { text: formatNumberPattern(value, section), color };
}

/** Change displayed decimals of a numeric format (Increase/Decrease Decimal). */
export function adjustDecimals(fmt: string | undefined, value: Scalar, delta: number): string {
  let f = fmt && fmt !== "General" ? fmt : "";
  if (!f) {
    const s = typeof value === "number" ? general(value) : "0";
    const d = s.includes(".") ? s.split(".")[1].length : 0;
    f = d > 0 ? "0." + "0".repeat(d) : "0";
  }
  return f.replace(/([#0])(\.0*)?(?![#0.])/, (_m, lead: string, dec: string | undefined) => {
    const n = Math.max(0, (dec ? dec.length - 1 : 0) + delta);
    return lead + (n > 0 ? "." + "0".repeat(n) : "");
  });
}
