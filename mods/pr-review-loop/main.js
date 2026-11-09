// PR Review Loop: the focused space's PRs in review order and whose turn it is, from the
// pr-review-loop Claude Code plugin's pr-status.json, plus the PRs its Claude sessions opened.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, focused, home, panes, props, readTextFile, run, setShared, spaces, theme, window as appWindow } from "herdr";
import * as M from "./model.js";

const NEEDS_YOU = "pr-review-loop.needsYou";
const INSTALL = "claude plugin marketplace add baruchiro/skills && claude plugin install pr-review-loop@skills";
const POLL_MS = 5000;
const LOCAL_MS = 15000;
const TICK_MS = 30000;
const SESSION = "session";

const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};

export default class PrReviewLoop extends View {
  init(_props, cx) {
    this.log = [];
    this.files = new Map();
    this.paths = [];
    this.space = undefined;
    this.cache = load("session-cache", {});
    this.local = new Map();
    this.roots = new Map();
    this.lastRun = {};
    this.busy = new Set();
    this.errors = {};
    this.scriptMissing = false;
    this.expanded = new Set(load("expanded", []));
    this.homes = load("homes", {});
    this.active = (appWindow()?.active ?? true);
    this.poll(cx);
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    cx.timer.every(LOCAL_MS, (cx) => this.refreshLocal(cx));
    cx.timer.every(TICK_MS, (cx) => { this.refreshOwed(cx); cx.notify(); });
  }

  options() {
    const p = props() ?? {};
    return {
      interval: Math.max(0, Number(p.refreshSeconds ?? 300) || 0) * 1000,
      script: p.script ?? "",
      sessionLog: (p.sessionLog ?? "~/.local/state/claude-session-prs.jsonl").replace(/^~(?=\/)/, home()),
    };
  }

  context() {
    const all = spaces();
    const tabSpace = new Map(all.flatMap((s) => s.tabs.map((tb) => [tb.id, s.id])));
    const live = new Map(panes().filter((p) => p.terminal && tabSpace.has(p.tab)).map((p) => [p.terminal, tabSpace.get(p.tab)]));
    this.remember(live);
    const space = all.find((s) => s.id === focused()?.space);
    if (!space || space.machine) return { space, cwds: [], entries: [] };
    const shown = panes().filter((p) => p.terminal && live.get(p.terminal) === space.id);
    const paneCwds = [...new Set(shown.map((p) => p.cwd).filter(Boolean))];
    // A closed session's PRs stay with the space it ran in; a terminal never seen here goes by folder.
    const owner = (e) => live.get(e.terminal) ?? this.homes[e.terminal] ?? ([space.folder, ...paneCwds].includes(e.cwd) ? space.id : undefined);
    const entries = this.log.filter((e) => owner(e) === space.id);
    const cwds = [...new Set([...paneCwds, ...entries.map((e) => e.cwd), space.folder].filter((d) => d?.startsWith("/")))];
    return { space, cwds, entries, paneCwds };
  }

  remember(live) {
    let changed = false;
    for (const [terminal, space] of live) {
      if (this.homes[terminal] !== space) {
        this.homes[terminal] = space;
        changed = true;
      }
    }
    if (changed) try { localStorage.setItem("homes", JSON.stringify(this.homes)); } catch {}
  }

  model() {
    const ctx = this.context();
    const sections = this.paths.map((p) => this.files.get(p)).filter(Boolean);
    const inFiles = new Set(sections.flatMap((s) => (s.file?.prs ?? []).map((p) => M.prKey(p).toLowerCase())));
    const seen = new Set();
    const session = [...ctx.entries].reverse().flatMap((e) => {
      const spec = M.specFromUrl(e.url)?.toLowerCase();
      if (!spec || seen.has(spec) || inFiles.has(spec)) return [];
      seen.add(spec);
      return [{ url: e.url, spec, pr: this.cache[spec]?.pr }];
    });
    const lists = [...sections.map((s) => s.file?.prs ?? []), session.flatMap((s) => s.pr ?? [])];
    return { ctx, sections, session, lists, needsYou: M.countNeedsYou(lists, new Set(this.local.keys())) };
  }

  publish(cx) {
    setShared(NEEDS_YOU, this.model().needsYou);
    cx.notify();
  }

  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        await this.readLog();
        const ctx = this.context();
        const texts = new Map();
        const read = async (dir) => {
          if (!texts.has(dir)) texts.set(dir, await readTextFile(`${dir}/pr-status.json`).catch(() => null));
          return texts.get(dir);
        };
        const found = [];
        for (const cwd of ctx.cwds) {
          for (const dir of M.ancestors(cwd, home())) {
            const text = await read(dir);
            if (text == null) continue;
            const path = `${dir}/pr-status.json`;
            if (!found.includes(path)) found.push(path);
            const prev = this.files.get(path);
            if (prev?.text !== text) this.files.set(path, this.parse(dir, text, prev));
            break;
          }
        }
        const spaceChanged = this.space !== ctx.space?.id;
        this.paths = found;
        this.space = ctx.space?.id;
        if (spaceChanged) this.refreshLocal(cx);
        this.refreshOwed(cx);
        this.publish(cx);
      } finally {
        this.polling = false;
      }
    });
  }

  async readLog() {
    const text = (await readTextFile(this.options().sessionLog).catch(() => null)) ?? "";
    if (text === this.logText) return;
    this.logText = text;
    this.log = text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const e = JSON.parse(line);
        return typeof e?.url === "string" ? [e] : [];
      } catch {
        return [];
      }
    });
  }

  parse(folder, text, prev) {
    try {
      return { folder, text, file: M.parseStatusFile(text) };
    } catch (e) {
      return { folder, text, file: prev?.file, error: e.message };
    }
  }

  refreshOwed(cx, force = false) {
    const { interval } = this.options();
    if (!force && (!interval || !(appWindow()?.active ?? true))) return;
    cx.spawn(async (cx) => {
      const script = await this.script();
      this.scriptMissing = !script;
      if (!script) return cx.notify();
      const now = Date.now();
      for (const path of this.paths) {
        const entry = this.files.get(path);
        const specs = entry?.file ? M.prSpecs(entry.file.prs) : [];
        const last = Math.max(this.lastRun[path] ?? 0, Date.parse(entry?.file?.generatedAt) || 0);
        if (specs.length && (force || now - last >= interval)) {
          this.runScript(cx, path, [script, path, `${entry.folder}/pr-review-links.json`, ...specs], entry.folder);
        }
      }
      const owed = this.model().session.filter((s) => {
        const c = this.cache[s.spec];
        if (c && ["MERGED", "CLOSED"].includes(c.pr.state) && !force) return false;
        return force || !c || now - c.at >= interval;
      });
      if (owed.length) this.runScript(cx, SESSION, [script, "-", "/dev/null", ...owed.map((s) => M.specFromUrl(s.url))], home());
    });
  }

  async script() {
    const installed = await readTextFile(`${home()}/.claude/plugins/installed_plugins.json`).catch(() => null);
    return M.findScript(this.options().script, installed);
  }

  runScript(cx, key, args, cwd) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("bash", [`${appHome()}/mods/pr-review-loop/refresh.sh`, ...args], { cwd, timeout: 120000 })
        .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      this.busy.delete(key);
      this.lastRun[key] = Date.now();
      delete this.errors[key];
      if (r.code === 0 && key === SESSION) this.store(r.stdout, key);
      else if (r.code !== 0 && r.code !== 4) this.errors[key] = r.stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? `refresh exited with code ${r.code}`;
      if (key === SESSION) this.publish(cx);
      else this.poll(cx);
    });
  }

  store(stdout, key) {
    try {
      const at = Date.now();
      for (const pr of M.validPrs(JSON.parse(stdout), "pr-status.sh output")) this.cache[M.prKey(pr).toLowerCase()] = { pr, at };
      localStorage.setItem("session-cache", JSON.stringify(this.cache));
    } catch (e) {
      this.errors[key] = e.message;
    }
  }

  refreshLocal(cx) {
    cx.spawn(async (cx) => {
      const git = (args, cwd) => exec("git", args, { cwd, timeout: 10000 }).catch(() => ({ code: 1, stdout: "" }));
      const roots = new Set();
      for (const cwd of this.context().paneCwds ?? []) {
        if (!this.roots.has(cwd)) {
          const r = await git(["rev-parse", "--show-toplevel"], cwd);
          this.roots.set(cwd, r.code === 0 ? r.stdout.trim() : null);
        }
        if (this.roots.get(cwd)) roots.add(this.roots.get(cwd));
      }
      const repos = await Promise.all([...roots].map(async (root) => {
        const [remotes, head, status, refs] = await Promise.all([
          git(["remote", "-v"], root),
          git(["symbolic-ref", "--quiet", "--short", "HEAD"], root),
          git(["status", "--porcelain"], root),
          git(["for-each-ref", "--format=%(refname:short)%09%(upstream:track)", "refs/heads"], root),
        ]);
        const ahead = {};
        for (const line of refs.stdout.split("\n")) {
          const [name, track] = line.split("\t");
          const n = /ahead (\d+)/.exec(track ?? "");
          if (name && n) ahead[name] = Number(n[1]);
        }
        return {
          remotes: remotes.stdout.split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean),
          head: head.code === 0 ? head.stdout.trim() : undefined,
          dirty: status.stdout.split("\n").filter(Boolean).length,
          ahead,
        };
      }));
      const next = M.localChangesFor(this.model().lists.flat(), repos);
      const same = next.size === this.local.size && [...next].every(([k, v]) => this.local.get(k) === v);
      if (!same) {
        this.local = next;
        this.publish(cx);
      }
    });
  }

  toggle(id) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    try { localStorage.setItem("expanded", JSON.stringify([...this.expanded])); } catch {}
  }

  openUrl(url) {
    let u;
    try { u = new URL(url); } catch { return; }
    if (u.protocol !== "https:" || u.hostname !== "github.com") return;
    const platform = appWindow()?.platform;
    const [cmd, args] = platform === "macos" ? ["open", [u.href]] : platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", u.href]] : ["xdg-open", [u.href]];
    exec(cmd, args).catch(() => null);
  }

  render(cx) {
    const t = theme();
    const active = (appWindow()?.active ?? true);
    if (active && !this.active) this.refreshOwed(cx);
    this.active = active;
    const { ctx, sections, session } = this.model();
    if (ctx.space?.id !== this.space) this.poll(cx);

    const tone = { orange: t.blocked, purple: t.ansi5, red: t.ansi1, yellow: t.ansi3, green: t.ansi2 };
    const tint = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}29` : c);
    const pill = (p, meta = false) => {
      const c = tone[p.tone];
      return h_flex().h(18).px(7).flex_none().items_center().rounded(9).text_size(11).whitespace_nowrap()
        .when(!meta, (el) => el.font_semibold())
        .text_color(c ?? t.muted).bg(c ? tint(c) : t.raised)
        .child(p.label);
    };
    const statusPills = (pr) => (pr.status ? [M.pillFor(pr), M.ciPillFor(pr), M.crPillFor(pr)].filter(Boolean).map((p) => pill(p)) : [pill({ label: "Checking…", tone: "neutral" })]);
    const metaPills = (pr) => [
      ...(pr.phase === "draft" ? [pill({ label: "Draft", tone: "neutral" }, true)] : []),
      ...(pr.base ? [pill({ label: `${pr.repo} → ${pr.base}`, tone: "neutral" }, true)] : []),
      ...(typeof pr.files === "number" ? [pill({ label: pr.files === 1 ? "1 file" : `${pr.files} files`, tone: "neutral" }, true)] : []),
    ];
    const button = (id, label, primary, onClick) =>
      h_flex().id(id).h(24).px(10).items_center().rounded(5).text_size(12).cursor_pointer()
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover)))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
        .child(label);
    const actions = (pr, id) => h_flex().gap(6).flex_wrap()
      .child(button(`open-${id}`, "Open PR", true, () => this.openUrl(pr.url)))
      .when(pr.reviewOrder === "stale", (el) => el.child(
        h_flex().id(`stale-${id}`).h(24).px(10).items_center().rounded(5).text_size(12).bg(t.raised).text_color(t.dim)
          .tooltip("The review order is out of date for the latest commits").child("Review order (stale)")))
      .when(Boolean(pr.reviewOrder) && pr.reviewOrder !== "stale", (el) => el.child(button(`order-${id}`, "Review order", false, () => this.openUrl(pr.reviewOrder))));
    const hint = (text) => div().text_size(12).line_height("18px").text_color(t.muted).child(text);
    const heading = (text, label, tip) => h_flex().px(2).gap(6).text_size(11).font_semibold().text_color(t.muted)
      .child(text.toUpperCase())
      .when(Boolean(label), (el) => el.child(div().id(`label-${text}-${label}`).flex_1().min_w(0).truncate().text_right().font_normal().text_color(t.dim).tooltip(tip ?? label).child(label)));
    const row = (pr, i, scope) => {
      const id = `${scope}\n${M.prKey(pr)}`;
      const rid = `${scope}-${M.prKey(pr)}`;
      const open = this.expanded.has(id);
      const local = this.local.get(M.prKey(pr));
      const done = pr.state === "MERGED" || pr.state === "CLOSED";
      const head = h_flex().id(`row-${rid}`).gap(8).px(8).py(6).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(`#${pr.number} ${pr.title}`)
        .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
        .child(div().w(14).flex_none().text_right().text_size(11).text_color(t.dim).child(String(i + 1)))
        .child(div().flex_1().min_w(0).truncate()
          .child(`#${pr.number} ${pr.title}`))
        .when(Boolean(local), (el) => el.child(pill({ label: "Local changes", tone: "purple" })))
        .children(statusPills(pr));
      return v_flex().rounded(6).bg(t.surface).when(done, (el) => el.opacity(0.6))
        .child(head)
        .when(open, (el) => el.child(v_flex().gap(6).pt(4).pb(8).pl(30).pr(8)
          .when(Boolean(pr.hint), (el) => el.child(hint(pr.hint)))
          .when(Boolean(local), (el) => el.child(hint(`⟳ ${local}`)))
          .child(h_flex().gap(4).flex_wrap().children(metaPills(pr)))
          .child(actions(pr, rid))));
    };

    const error = (text) => div().text_size(12).text_color(t.ansi1).child(`⚠ ${text}`);
    const group = (title, label, tip, err, prs, scope) => v_flex().gap(6)
      .child(heading(title, label, tip))
      .when(Boolean(err), (el) => el.child(error(err)))
      .child(v_flex().gap(4).children(prs.map((pr, i) => row(pr, i, scope))));

    const sessionPrs = session.map((s) => s.pr ?? { url: s.url, repo: s.spec.split("#")[0], number: Number(s.spec.split("#")[1]), title: s.url.replace("https://github.com/", ""), status: "", next: "none" });
    const keys = [...this.paths, SESSION];
    const busy = keys.some((k) => this.busy.has(k));
    const failure = keys.map((k) => this.errors[k]).find(Boolean);
    const generated = [...sections.map((s) => Date.parse(s.file?.generatedAt) || 0), ...session.map((s) => this.cache[s.spec]?.at ?? 0)];
    const updated = Math.max(0, ...generated);
    const empty = sections.length === 0 && session.length === 0;
    const link = (id, label, onClick) => div().id(id).text_color(t.accent).cursor_pointer().hover((s) => s.underline()).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);

    const footer = h_flex().flex_none().gap(6).px(14).py(8).flex_wrap().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .when(updated > 0, (el) => el.child(`Updated ${M.ago(Date.now() - updated)}`))
      .when(this.options().interval === 0, (el) => el.child("· auto refresh off"))
      .when(this.scriptMissing, (el) => el
        .child("· refresh off: pr-review-loop skill not found")
        .child(link("install", "Install", () => run("tab.new", { name: "Install PR Review Loop", argv: ["sh", "-c", INSTALL] }))))
      .when(!this.scriptMissing && Boolean(failure), (el) => el
        .child(div().text_color(t.ansi1).child(`⚠ ${failure}`))
        .child(link("retry", "Retry", (cx) => this.refreshOwed(cx, true))));

    return v_flex().id("pr-review-loop").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Pull requests"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(ctx.space?.name ?? ""))
        .child(h_flex().id("refresh").size(24).flex_none().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .tooltip("Refresh")
          .on_click((_e, cx) => this.refreshOwed(cx, true))
          .child(svg("mods/pr-review-loop/refresh.svg").size(14).when(busy, (el) => el.spin(900)))))
      .child(v_flex().id("pr-body").flex_1().min_h(0).p(12).gap(14).overflow_y_scrollbar()
        .when(Boolean(ctx.space?.machine), (el) => el.child(hint("PRs are shown for spaces on this computer only.")))
        .when(empty && !ctx.space?.machine, (el) => el.child(hint("No pr-status.json in this space's folders, and no PRs opened from it yet.")))
        .children(sections.map((s, i) => group(
          `Review order · ${s.file?.prs.length ?? 0}`,
          sections.length > 1 ? s.folder.split("/").pop() : undefined,
          s.folder, s.error, s.file?.prs ?? [], `f${i}`)))
        .when(session.length > 0, (el) => el.child(group(`Opened in this space · ${session.length}`, undefined, undefined, undefined, sessionPrs, SESSION))))
      .child(footer);
  }
}
