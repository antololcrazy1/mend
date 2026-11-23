// main.ts is mend, the CLI SPEC.md specifies. It applies an edit an AI model wrote, in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text files.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit. It throws Fail when it fails, and reports a move it made by returning it. */
type Edit = (tree: Tree) => { move?: [string, string] } | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Files: lines and line breaks (SPEC section 3)                      */
/* ------------------------------------------------------------------ */

interface FileShape {
  br: string;
  lines: string[];
  final: boolean;
}

function fileLines(text: string): FileShape {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC section 5)                                    */
/* ------------------------------------------------------------------ */

const stripLead = (s: string): string => s.replace(/^[ \t]+/, '');
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(stripLead(s));
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** 0-based positions at which O occurs in lines, at a tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || from < 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    const positions = occurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` line. */
interface Item {
  k: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

const oldOf = (items: Item[]): string[] => items.filter((i) => i.k !== 'new' && i.k !== 'bs').map((i) => i.text);
const newOf = (items: Item[]): string[] => items.filter((i) => i.k !== 'old' && i.k !== 'bs').map((i) => i.text);

/**
 * The lines that replace a matched occurrence: context lines are the file's own matched lines,
 * new lines are re-indented at tier 2 (section 5).
 */
function buildNew(lines: string[], pos: number, items: Item[], tier: number): string[] {
  const o = oldOf(items);
  const f = leadOf(lines[pos] ?? '');
  const p = leadOf(o[0] ?? '');
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.k === 'old' || it.k === 'bs') {
      if (it.k === 'old') oi++;
      continue;
    }
    if (it.k === 'ctx') {
      out.push(lines[pos + oi]!);
      oi++;
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** A `\` line follows the hunk's last context or `+` line: the result then ends without a break. */
function noFinalBreak(items: Item[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.k === 'ctx' || items[i]!.k === 'new') last = i;
  }
  if (last < 0) return false;
  return items[last + 1] !== undefined && items[last + 1]!.k === 'bs';
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                        */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                     */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A leading a/ or b/ is removed from a --- / +++ path. */
const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The path of a --- / +++ line: after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'body' = 'outside';
  let pairSet = false;
  const startSection = (gitOld: string | null, gitNew: string | null): Section => {
    const s: Section = { gitOld, gitNew, pairOld: null, pairNew: null, renOld: null, renNew: null, create: false, del: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection(m[1]!, m[2]!);
      state = 'header';
      pairSet = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) {
        if (state === 'header') throw new Exit2(`error: parse ${i + 2}`);
        i++;
        continue;
      }
      if (state === 'outside' || state === 'body' || (state === 'header' && pairSet)) {
        cur = startSection(null, null);
        state = 'header';
        pairSet = true;
        cur.pairOld = stripPrefix(headerPath(line));
        cur.pairNew = stripPrefix(headerPath(next));
      } else {
        cur!.pairOld = stripPrefix(headerPath(line));
        cur!.pairNew = stripPrefix(headerPath(next));
        pairSet = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const items: Item[] = [];
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          raw.push(b);
          items.push({ k: 'ctx', text: '' });
          j++;
          continue;
        }
        if (b.startsWith(' ')) {
          raw.push(b);
          items.push({ k: 'ctx', text: b.slice(1) });
          j++;
          continue;
        }
        if (b.startsWith('-')) {
          raw.push(b);
          items.push({ k: 'old', text: b.slice(1) });
          j++;
          continue;
        }
        if (b.startsWith('+')) {
          raw.push(b);
          items.push({ k: 'new', text: b.slice(1) });
          j++;
          continue;
        }
        if (b.startsWith('\\')) {
          raw.push(b);
          items.push({ k: 'bs', text: b });
          j++;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') {
        raw.pop();
        items.pop();
      }
      cur.hunks.push({ a: Number(m[1]), items });
      state = 'body';
      i = j;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('+++ ')) {
        cur.pairNew = stripPrefix(headerPath(line));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renOld === null) cur.renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renNew === null) cur.renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail on a hunk failure. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const shape = fileLines(before);
  let lines = [...shape.lines];
  let final = shape.final;
  let d = 0;
  for (const h of hunks) {
    const o = oldOf(h.items);
    const n = newOf(h.items);
    if (o.length === 0) {
      const idx = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = idx === lines.length;
      lines.splice(idx, 0, ...n);
      if (atEnd) final = !noFinalBreak(h.items);
    } else {
      const found = findTier(lines, o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          pos = p;
          best = dist;
        }
      }
      const replaced = buildNew(lines, pos, h.items, found.tier);
      const atEnd = pos + o.length === lines.length;
      lines.splice(pos, o.length, ...replaced);
      if (atEnd) final = !noFinalBreak(h.items);
    }
    d += n.length - o.length;
  }
  return joinLines(lines, shape.br, final);
}

/** A created file ends with a break unless a `\` line follows its last `+` line. */
function creationNoFinalBreak(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const items = hunks[h]!.items;
    for (let idx = items.length - 1; idx >= 0; idx--) {
      if (items[idx]!.k === 'new') return items[idx + 1] !== undefined && items[idx + 1]!.k === 'bs';
    }
  }
  return false;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => {
    const old = s.pairOld ?? s.renOld ?? s.gitOld;
    const nw = s.pairNew ?? s.renNew ?? s.gitNew;
    const isCreate = old === '/dev/null' || s.create;
    const isDelete = nw === '/dev/null' || s.del;
    return (tree: Tree) => {
      if (isCreate) {
        const p = nw ?? old ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of s.hunks) for (const it of h.items) if (it.k === 'new') plus.push(it.text);
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (creationNoFinalBreak(s.hunks) ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const p = old ?? nw ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (old === null && nw === null) return;
      if (old !== null && nw !== null && old !== nw) {
        if (!safe(old)) throw new Fail('unsafe', old);
        if (!safe(nw)) throw new Fail('unsafe', nw);
        const before = tree.get(old);
        if (before === null) throw new Fail('missing', old);
        if (tree.get(nw) !== null) throw new Fail('exists', nw);
        const out = applyHunks(before, s.hunks, strict, old);
        tree.now.set(old, null);
        tree.now.set(nw, out);
        return { move: [old, nw] };
      }
      const p = (old ?? nw)!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                             */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push((tree: Tree) => {
      if (!safe(path!)) throw new Fail('unsafe', path!);
      if (oldLines.length === 0) {
        if (tree.get(path!) !== null) throw new Fail('exists', path!);
        tree.now.set(path!, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(path!);
      if (before === null) throw new Fail('missing', path!);
      const shape = fileLines(before);
      const found = findTier(shape.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', path!);
      if (found.positions.length > 1) throw new Fail('ambiguous', path!);
      const pos = found.positions[0]!;
      const items: Item[] = [
        ...oldLines.map((t): Item => ({ k: 'old' as const, text: t })),
        ...newLines.map((t): Item => ({ k: 'new' as const, text: t })),
      ];
      const replaced = buildNew(shape.lines, pos, items, found.tier);
      const out = [...shape.lines.slice(0, pos), ...replaced, ...shape.lines.slice(pos + oldLines.length)];
      tree.now.set(path!, joinLines(out, shape.br, shape.final));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                       */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
}

const V4A_START = (l: string): 'add' | 'delete' | 'update' | null => {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'delete';
  if (l.startsWith('*** Update File: ')) return 'update';
  return null;
};

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const kind = V4A_START(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = lines[i]!.slice(prefix.length).trim();
    const lineNo = i + 1;
    let j = i + 1;
    while (j < last && V4A_START(lines[j]!) === null) j++;
    const raw: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k]!, no: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push({ kind, path, lineNo, moveTo: null, lines: [], chunks: [] });
    const sec = sections[sections.length - 1]!;
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.lines.push(r.text.slice(1));
        else if (r.text === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let idx = 0;
      while (idx < raw.length && blank(raw[idx]!.text)) idx++;
      if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[idx]!.text.slice('*** Move to: '.length).trim();
        idx++;
      }
      let firstChunk = true;
      while (true) {
        while (idx < raw.length && blank(raw[idx]!.text)) idx++;
        if (idx >= raw.length) break;
        const l = raw[idx]!;
        if (l.text.trim() === '*** End of File') throw new Exit2(`error: parse ${l.no}`);
        let anchor: string | null = null;
        if (l.text.startsWith('@@')) {
          anchor = l.text.slice(2).trim();
          idx++;
        } else if (!firstChunk) {
          throw new Exit2(`error: parse ${l.no}`);
        }
        const items: Item[] = [];
        let eof = false;
        while (idx < raw.length) {
          const b = raw[idx]!;
          if (b.text.startsWith('@@')) break;
          if (b.text.trim() === '*** End of File') {
            eof = true;
            idx++;
            break;
          }
          if (b.text === '') {
            items.push({ k: 'ctx', text: '' });
            idx++;
            continue;
          }
          if (b.text.startsWith(' ')) {
            items.push({ k: 'ctx', text: b.text.slice(1) });
            idx++;
            continue;
          }
          if (b.text.startsWith('-')) {
            items.push({ k: 'old', text: b.text.slice(1) });
            idx++;
            continue;
          }
          if (b.text.startsWith('+')) {
            items.push({ k: 'new', text: b.text.slice(1) });
            idx++;
            continue;
          }
          throw new Exit2(`error: parse ${b.no}`);
        }
        sec.chunks.push({ anchor, items, eof });
        firstChunk = false;
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
    }
    i = j;
  }
  return sections.map((sec) => v4aSectionEdit(sec, strict));
}

/** The first line at or after the cursor equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
    };
  }
  if (sec.kind === 'delete') {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const shape = fileLines(before);
    const lines = [...shape.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = findAnchor(lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const o = oldOf(chunk.items);
      if (o.length === 0) {
        const idx = chunk.eof ? lines.length : cursor;
        const ins = newOf(chunk.items);
        lines.splice(idx, 0, ...ins);
        cursor = idx + ins.length;
      } else {
        const found = findTier(lines, o, strict, cursor);
        if (!found) throw new Fail('no-match', sec.path);
        let pos = -1;
        for (const p of found.positions) {
          if (!chunk.eof || p + o.length === lines.length) {
            pos = p;
            break;
          }
        }
        if (pos < 0) throw new Fail('no-match', sec.path);
        const replaced = buildNew(lines, pos, chunk.items, found.tier);
        lines.splice(pos, o.length, ...replaced);
        cursor = pos + replaced.length;
      }
    }
    const out = joinLines(lines, shape.br, shape.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      return { move: [sec.path, sec.moveTo] };
    }
    tree.now.set(sec.path, out);
  };
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC sections 1, 2 and 10)                        */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const r = edit(tree);
      if (r !== undefined && r.move !== undefined) moves.push(r.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [old, nw] of moves) {
    const wasOld = tree.original(old);
    const wasNew = tree.original(nw);
    const nowOld = tree.now.has(old) ? tree.now.get(old)! : wasOld;
    const nowNew = tree.now.has(nw) ? tree.now.get(nw)! : wasNew;
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      suppressed.add(`D:${old}`);
      suppressed.add(`A:${nw}`);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kindRow = was === null ? 'A' : now === null ? 'D' : 'M';
    if (suppressed.has(`${kindRow}:${p}`)) continue;
    rows.push({ key: p, line: `${kindRow} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
