// Ported from the PR Review Loop VS Code extension (model.ts, refresh.ts, localChanges.ts).

const PILLS = {
  "needs-you": { label: "Needs you", tone: "orange" },
  "needs-agent": { label: "Claude's turn", tone: "purple" },
  "ci-failing": { label: "CI failing", tone: "red" },
  "cr-pending": { label: "CodeRabbit running", tone: "yellow" },
  "ci-pending": { label: "Waiting", tone: "neutral" },
  "cr-not-triggered": { label: "Check CodeRabbit", tone: "yellow" },
  "cr-no-activity": { label: "Check CodeRabbit", tone: "yellow" },
  "ready": { label: "Ready to merge", tone: "green" },
  "clean": { label: "Draft · review it", tone: "neutral" },
  "merged": { label: "Merged", tone: "neutral" },
  "closed": { label: "Closed", tone: "neutral" },
};

const REQUIRED_STRINGS = ["repo", "title", "url", "status", "next"];

export function validPrs(prs, where) {
  if (!Array.isArray(prs)) throw new Error(`${where} has no prs array`);
  const bad = prs.findIndex((p) => !(p && typeof p === "object" && Number.isInteger(p.number) && REQUIRED_STRINGS.every((k) => typeof p[k] === "string")));
  if (bad >= 0) throw new Error(`${where} prs[${bad}] needs string repo, title, url, status and next, and an integer number`);
  return prs;
}

export function parseStatusFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  if (!data || data.version !== 1) throw new Error(`Unsupported pr-status.json version: ${data?.version}`);
  validPrs(data.prs, "pr-status.json");
  return data;
}

export const prKey = (pr) => `${pr.repo}#${pr.number}`;

export function pillFor(pr) {
  const status = pr.status.slice(pr.status.indexOf(":") + 1);
  const pill = PILLS[status];
  if (!pill) return { label: pr.status, tone: "neutral" };
  if (status === "needs-you" && pr.threads) return { label: `${pill.label} · ${pr.threads}`, tone: pill.tone };
  return pill;
}

export const ciPillFor = (pr) =>
  pr.ci === "pending" || pr.status.endsWith(":ci-pending") ? { label: "CI running", tone: "yellow" } : undefined;

export const crPillFor = (pr) =>
  pr.cr === "running" && !pr.status.endsWith(":cr-pending") ? { label: "CodeRabbit running", tone: "yellow" } : undefined;

const needsYou = (pr, local) => pr.next === "you" && !local.has(prKey(pr));

export const countNeedsYou = (lists, local) =>
  new Set(lists.flat().filter((p) => needsYou(p, local)).map(prKey)).size;

const SCRIPT_TAIL = "/skills/resolving-pr-review-comments/pr-status.sh";

export function findScript(setting, installedPluginsJson) {
  if (typeof setting === "string" && setting.startsWith("/")) return setting;
  if (!installedPluginsJson) return undefined;
  let plugins;
  try {
    plugins = JSON.parse(installedPluginsJson).plugins ?? {};
  } catch {
    return undefined;
  }
  for (const prefix of ["pr-review-loop@", "baruchiro@"]) {
    const key = Object.keys(plugins).find((k) => k.startsWith(prefix));
    const installPath = key && plugins[key]?.[0]?.installPath;
    if (installPath) return installPath + SCRIPT_TAIL;
  }
  return undefined;
}

const SAFE_REPO = /^(?!-)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const safeSpec = (repo, number) => typeof repo === "string" && SAFE_REPO.test(repo) && Number.isInteger(number) && number > 0;

export const prSpecs = (prs) => prs.filter((p) => safeSpec(p.repo, p.number)).map(prKey);

export function specFromUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m && safeSpec(m[1], Number(m[2])) ? `${m[1]}#${m[2]}` : undefined;
}

export function parseRemote(url) {
  const m = /^(?:[\w+]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

// repos: [{ remotes: [url], head, dirty, ahead: { branch: n } }]
export function localChangesFor(prs, repos) {
  const result = new Map();
  for (const pr of prs) {
    const branch = pr.headRefName;
    if (!branch) continue;
    const slug = pr.repo.toLowerCase();
    for (const repo of repos.filter((r) => r.remotes.some((u) => parseRemote(u) === slug))) {
      const ahead = repo.ahead[branch] ?? 0;
      if (repo.head === branch && repo.dirty > 0) {
        result.set(prKey(pr), `${repo.dirty} uncommitted files on ${branch}`);
        break;
      }
      if (ahead > 0) {
        result.set(prKey(pr), `${ahead} unpushed commits on ${branch}`);
        break;
      }
    }
  }
  return result;
}

// Folders from `dir` up to, not above, `home`, nearest first. Outside home: only `dir`.
export function ancestors(dir, home) {
  const out = [];
  let d = dir.replace(/\/+$/, "") || "/";
  if (d !== home && !d.startsWith(home + "/")) return [d];
  while (d !== home && d.length > home.length) {
    out.push(d);
    d = d.slice(0, d.lastIndexOf("/")) || "/";
  }
  return out;
}

export function ago(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
