// DQL parser: tokenizer + expression (recursive-descent by precedence) + query.

export type Expr =
  | { t: "lit"; v: unknown }
  | { t: "list"; items: Expr[] }
  | { t: "link"; name: string; subpath: string | null; display: string | null }
  | { t: "var"; name: string }
  | { t: "member"; obj: Expr; name: string }
  | { t: "index"; obj: Expr; idx: Expr }
  | { t: "call"; name: string; args: Expr[] }
  | { t: "unary"; op: string; e: Expr }
  | { t: "binary"; op: string; l: Expr; r: Expr };

export type Source =
  | { s: "all" }
  | { s: "tag"; tag: string }
  | { s: "folder"; path: string }
  | { s: "incoming"; link: string }
  | { s: "outgoing"; link: string }
  | { s: "this" }
  | { s: "and"; a: Source; b: Source }
  | { s: "or"; a: Source; b: Source }
  | { s: "not"; a: Source };

export type QueryType = "TABLE" | "LIST" | "TASK" | "CALENDAR";
export interface Column {
  expr: Expr;
  header: string;
}
export interface SortKey {
  expr: Expr;
  dir: "asc" | "desc";
}
export type Command =
  | { k: "where"; e: Expr }
  | { k: "sort"; keys: SortKey[] }
  | { k: "group"; e: Expr; as: string }
  | { k: "flatten"; e: Expr; as: string }
  | { k: "limit"; n: number };

export interface Query {
  type: QueryType;
  withoutId: boolean;
  columns: Column[];
  listExpr: Expr | null;
  calendarExpr: Expr | null;
  from: Source | null;
  commands: Command[];
}

// ---- Tokenizer ----

type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "ident"; v: string }
  | { k: "link"; name: string; subpath: string | null; display: string | null }
  | { k: "op"; v: string }
  | { k: "eof" };

const OPS = ["<=", ">=", "!=", "<>", "&&", "||", "<", ">", "=", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "."];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Wikilink [[...]]
    if (c === "[" && src[i + 1] === "[") {
      const end = src.indexOf("]]", i + 2);
      const body = src.slice(i + 2, end === -1 ? n : end);
      const name = body.split("|")[0].split("#")[0].trim();
      const display = body.includes("|") ? body.split("|")[1].trim() : null;
      const subpath = body.includes("#") ? body.split("#")[1].split("|")[0].trim() : null;
      toks.push({ k: "link", name, subpath, display });
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < n) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j++];
        }
      }
      toks.push({ k: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      toks.push({ k: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_#]/.test(c)) {
      // identifier or #tag — always consume the start char, then word/-/#/ chars.
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_/#-]/.test(src[j])) j++;
      toks.push({ k: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    let matched = false;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        toks.push({ k: "op", v: op });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++; // skip unknown char
  }
  toks.push({ k: "eof" });
  return toks;
}

const CLAUSE_KW = new Set(["FROM", "WHERE", "SORT", "GROUP", "FLATTEN", "LIMIT", "AS", "BY", "ASC", "DESC"]);

// ---- Parser ----

class Parser {
  toks: Tok[];
  p = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok {
    return this.toks[this.p];
  }
  next(): Tok {
    return this.toks[this.p++];
  }
  isClauseKw(): boolean {
    const t = this.peek();
    return t.k === "ident" && CLAUSE_KW.has(t.v.toUpperCase());
  }
  eat(opv: string): boolean {
    const t = this.peek();
    if (t.k === "op" && t.v === opv) {
      this.p++;
      return true;
    }
    return false;
  }

  parseExpr(): Expr {
    return this.parseOr();
  }
  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.matchKw("or") || this.eat("||")) l = { t: "binary", op: "or", l, r: this.parseAnd() };
    return l;
  }
  private parseAnd(): Expr {
    let l = this.parseCmp();
    while (this.matchKw("and") || this.eat("&&")) l = { t: "binary", op: "and", l, r: this.parseCmp() };
    return l;
  }
  private parseCmp(): Expr {
    let l = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && ["=", "!=", "<>", "<", ">", "<=", ">="].includes(t.v)) {
        this.p++;
        l = { t: "binary", op: t.v === "<>" ? "!=" : t.v, l, r: this.parseAdd() };
      } else break;
    }
    return l;
  }
  private parseAdd(): Expr {
    let l = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && (t.v === "+" || t.v === "-")) {
        this.p++;
        l = { t: "binary", op: t.v, l, r: this.parseMul() };
      } else break;
    }
    return l;
  }
  private parseMul(): Expr {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && ["*", "/", "%"].includes(t.v)) {
        this.p++;
        l = { t: "binary", op: t.v, l, r: this.parseUnary() };
      } else break;
    }
    return l;
  }
  private parseUnary(): Expr {
    if (this.matchKw("not") || this.eat("!")) return { t: "unary", op: "not", e: this.parseUnary() };
    if (this.eat("-")) return { t: "unary", op: "-", e: this.parseUnary() };
    return this.parsePostfix();
  }
  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.eat(".")) {
        const t = this.next();
        if (t.k === "ident") e = { t: "member", obj: e, name: t.v };
        else break;
      } else if (this.eat("[")) {
        const idx = this.parseExpr();
        this.eat("]");
        e = { t: "index", obj: e, idx };
      } else break;
    }
    return e;
  }
  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.k === "num") {
      this.p++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "str") {
      this.p++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "link") {
      this.p++;
      return { t: "link", name: t.name, subpath: t.subpath, display: t.display };
    }
    if (t.k === "op" && t.v === "(") {
      this.p++;
      const e = this.parseExpr();
      this.eat(")");
      return e;
    }
    if (t.k === "op" && t.v === "[") {
      this.p++;
      const items: Expr[] = [];
      while (!(this.peek().k === "op" && (this.peek() as { v: string }).v === "]") && this.peek().k !== "eof") {
        items.push(this.parseExpr());
        if (!this.eat(",")) break;
      }
      this.eat("]");
      return { t: "list", items };
    }
    if (t.k === "ident") {
      const low = t.v.toLowerCase();
      if (low === "true") return (this.p++, { t: "lit", v: true });
      if (low === "false") return (this.p++, { t: "lit", v: false });
      if (low === "null") return (this.p++, { t: "lit", v: null });
      this.p++;
      // function call?
      if (this.peek().k === "op" && (this.peek() as { v: string }).v === "(") {
        this.p++;
        const args: Expr[] = [];
        while (!(this.peek().k === "op" && (this.peek() as { v: string }).v === ")") && this.peek().k !== "eof") {
          args.push(this.parseExpr());
          if (!this.eat(",")) break;
        }
        this.eat(")");
        return { t: "call", name: low, args };
      }
      return { t: "var", name: t.v };
    }
    this.p++;
    return { t: "lit", v: null };
  }
  private matchKw(kw: string): boolean {
    const t = this.peek();
    if (t.k === "ident" && t.v.toLowerCase() === kw) {
      this.p++;
      return true;
    }
    return false;
  }

  // ---- Source (FROM) ----
  parseSource(): Source {
    return this.parseSourceOr();
  }
  private parseSourceOr(): Source {
    let l = this.parseSourceAnd();
    while (this.matchKw("or")) l = { s: "or", a: l, b: this.parseSourceAnd() };
    return l;
  }
  private parseSourceAnd(): Source {
    let l = this.parseSourceTerm();
    while (this.matchKw("and")) l = { s: "and", a: l, b: this.parseSourceTerm() };
    return l;
  }
  private parseSourceTerm(): Source {
    if (this.eat("-") || this.matchKw("not")) return { s: "not", a: this.parseSourceTerm() };
    if (this.eat("(")) {
      const s = this.parseSourceOr();
      this.eat(")");
      return s;
    }
    const t = this.peek();
    if (t.k === "link") {
      this.p++;
      return t.name === "" ? { s: "this" } : { s: "incoming", link: t.name };
    }
    if (t.k === "str") {
      this.p++;
      return { s: "folder", path: t.v };
    }
    if (t.k === "ident") {
      // #tag (the '#' may be its own token-run); handle outgoing(...)
      if (t.v.toLowerCase() === "outgoing") {
        this.p++;
        this.eat("(");
        const inner = this.peek();
        let link = "";
        if (inner.k === "link") {
          this.p++;
          link = inner.name;
        }
        this.eat(")");
        return { s: "outgoing", link };
      }
      this.p++;
      const raw = t.v.replace(/^#/, "");
      return { s: "tag", tag: raw };
    }
    // A leading '#': tokenizer may emit '#tag' as ident starting with '#'
    this.p++;
    return { s: "all" };
  }
}

function headerFor(e: Expr): string {
  if (e.t === "member") return e.name;
  if (e.t === "var") return e.name;
  if (e.t === "call") return e.name;
  return "expr";
}

/** Parse a single expression (for inline DQL `= expr`). */
export function parseExpression(input: string): Expr {
  return new Parser(tokenize(input.trim())).parseExpr();
}

export function parseQuery(input: string): Query {
  const toks = tokenize(input.trim());
  const ps = new Parser(toks);
  const head = ps.next();
  const type = (head.k === "ident" ? head.v.toUpperCase() : "LIST") as QueryType;
  const q: Query = {
    type: ["TABLE", "LIST", "TASK", "CALENDAR"].includes(type) ? type : "LIST",
    withoutId: false,
    columns: [],
    listExpr: null,
    calendarExpr: null,
    from: null,
    commands: [],
  };

  if (q.type === "TABLE") {
    if (ps.peek().k === "ident" && (ps.peek() as { v: string }).v.toUpperCase() === "WITHOUT") {
      ps.next();
      if (ps.peek().k === "ident" && (ps.peek() as { v: string }).v.toUpperCase() === "ID") ps.next();
      q.withoutId = true;
    }
    while (!ps.isClauseKw() && ps.peek().k !== "eof") {
      const expr = ps.parseExpr();
      let header = headerFor(expr);
      if (ps.peek().k === "ident" && (ps.peek() as { v: string }).v.toUpperCase() === "AS") {
        ps.next();
        const h = ps.next();
        header = h.k === "str" ? h.v : h.k === "ident" ? h.v : header;
      }
      q.columns.push({ expr, header });
      if (!ps.eat(",")) break;
    }
  } else if (q.type === "LIST") {
    if (!ps.isClauseKw() && ps.peek().k !== "eof") q.listExpr = ps.parseExpr();
  } else if (q.type === "CALENDAR") {
    if (!ps.isClauseKw() && ps.peek().k !== "eof") q.calendarExpr = ps.parseExpr();
  }

  // FROM
  if (ps.peek().k === "ident" && (ps.peek() as { v: string }).v.toUpperCase() === "FROM") {
    ps.next();
    q.from = ps.parseSource();
  }

  // Commands
  while (ps.peek().k !== "eof") {
    const t = ps.next();
    if (t.k !== "ident") continue;
    const kw = t.v.toUpperCase();
    if (kw === "WHERE") {
      q.commands.push({ k: "where", e: ps.parseExpr() });
    } else if (kw === "SORT") {
      const keys: SortKey[] = [];
      do {
        const expr = ps.parseExpr();
        let dir: "asc" | "desc" = "asc";
        const d = ps.peek();
        if (d.k === "ident" && ["ASC", "DESC"].includes(d.v.toUpperCase())) {
          ps.next();
          dir = d.v.toUpperCase() === "DESC" ? "desc" : "asc";
        }
        keys.push({ expr, dir });
      } while (ps.eat(","));
      q.commands.push({ k: "sort", keys });
    } else if (kw === "GROUP") {
      if (ps.peek().k === "ident" && (ps.peek() as { v: string }).v.toUpperCase() === "BY") ps.next();
      const e = ps.parseExpr();
      let as = "key";
      if (ps.peek().k === "ident" && (ps.peek() as { v: string }).v.toUpperCase() === "AS") {
        ps.next();
        const h = ps.next();
        as = h.k === "str" || h.k === "ident" ? (h as { v: string }).v : as;
      }
      q.commands.push({ k: "group", e, as });
    } else if (kw === "FLATTEN") {
      const e = ps.parseExpr();
      let as = headerFor(e);
      if (ps.peek().k === "ident" && (ps.peek() as { v: string }).v.toUpperCase() === "AS") {
        ps.next();
        const h = ps.next();
        as = h.k === "str" || h.k === "ident" ? (h as { v: string }).v : as;
      }
      q.commands.push({ k: "flatten", e, as });
    } else if (kw === "LIMIT") {
      const e = ps.parseExpr();
      const n = e.t === "lit" && typeof e.v === "number" ? e.v : 0;
      q.commands.push({ k: "limit", n });
    }
  }

  return q;
}
