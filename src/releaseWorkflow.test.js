// (C)
// Guard tests for .github/workflows/release.yml.
//
// The release pipeline grew three gates after the 2026-08-21 audit (BRS-1 and
// BRS-7): a tag-vs-source version assert that runs before the build, an
// unconditional installer-completeness assert, and a hard failure when the
// build produced no .sig files. Every one of them is a silent-failure guard,
// which is exactly the kind a later edit deletes with nothing going red.
//
// These tests read the SHIPPED workflow text rather than a copy of it. js-yaml
// is already a production dependency (customThemes.js, SnippetsDrawer.jsx), so
// this costs nothing and stays honest: rewrite the YAML and these break.
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const WORKFLOW = fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url));
const wf = yaml.load(readFileSync(WORKFLOW, "utf8"));

const VERSION_STEP = "Assert the tag matches the source version";
const INSTALLERS_STEP = "Assert every matrix platform produced an installer";
const MANIFEST_STEP = "Build updater manifest (latest.json)";
const PUBLISH_STEP = "Publish GitHub Release";

const stepsOf = (job) => wf.jobs[job].steps;
const labels = (job) => stepsOf(job).map((s) => s.name || s.uses || "");

function step(job, name) {
  const found = stepsOf(job).find((s) => s.name === name);
  if (!found) throw new Error(`release.yml has no step named "${name}" in job "${job}"`);
  return found;
}

// Drop whole-line `#` comments. These bodies discuss `exit 0` in prose (the
// empty-sigs comment explains what the old warn-and-exit-0 did), so an
// assertion about control flow has to look at executable lines only.
const code = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

// Slice one `if ...; then ... fi` block out of a step body so an assertion can
// be about ONE branch instead of the whole script. Throws rather than returning
// empty: a silently-missing marker would make `not.toMatch` pass on "".
function shellBranch(body, marker) {
  const lines = body.split("\n");
  // Anchor on the `if` line itself, not on any line mentioning the condition:
  // these bodies carry comments naming the same condition right above it.
  const start = lines.findIndex((l) => /^\s*if\b/.test(l) && l.includes(marker));
  if (start < 0) throw new Error(`no branch matching ${marker}`);
  const indent = lines[start].match(/^\s*/)[0];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}fi`) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`unterminated branch matching ${marker}`);
}

describe("release.yml: the tag/source version gate (BRS-1)", () => {
  test("runs before the build, so a mistyped bump costs seconds not a matrix", () => {
    const build = stepsOf("build");
    const gate = build.findIndex((s) => s.name === VERSION_STEP);
    // Match on `uses` ALONE. The tauri step also has a `name`
    // ("Build the app + installers"), so a name-or-uses probe never sees the
    // action id and reports no build step at all.
    const tauri = build.findIndex((s) => (s.uses || "").startsWith("tauri-apps/tauri-action"));
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(tauri).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(tauri);
  });

  test("checks all three version files and fails the job on disagreement", () => {
    const body = step("build", VERSION_STEP).run;
    expect(body).toMatch(/check package\.json /);
    expect(body).toMatch(/check src-tauri\/Cargo\.toml /);
    expect(body).toMatch(/check src-tauri\/tauri\.conf\.json /);
    expect(body).toMatch(/^\s*exit 1$/m);
  });

  test("an unreadable version counts as a mismatch", () => {
    // Without the empty-string arm, reformatting any of the three files makes
    // the awk extraction return "" and the gate switches itself off silently.
    expect(step("build", VERSION_STEP).run).toContain('-z "$2"');
  });

  test("a manual run skips the check, because a branch dispatch has no tag", () => {
    const skip = shellBranch(step("build", VERSION_STEP).run, "workflow_dispatch");
    expect(skip).toMatch(/exit 0/);
  });
});

describe("release.yml: publish-job completeness gates (BRS-7)", () => {
  test("the installer assert is its own unconditional step, ahead of the manifest", () => {
    // It used to live inside the manifest step, BELOW the empty-sigs early
    // exit, so an unsigned build skipped the only check that a platform's
    // installer is actually present.
    const order = labels("publish");
    const installers = order.indexOf(INSTALLERS_STEP);
    const manifest = order.indexOf(MANIFEST_STEP);
    const publish = order.indexOf(PUBLISH_STEP);
    expect(installers).toBeGreaterThanOrEqual(0);
    expect(installers).toBeLessThan(manifest);
    expect(manifest).toBeLessThan(publish);
    expect(step("publish", INSTALLERS_STEP).if).toBeUndefined();
  });

  test("no .sig files fails the release instead of publishing without a manifest", () => {
    // eslint-disable-next-line no-template-curly-in-string -- shell parameter expansion, not a JS template
    const marker = "${#sigs[@]} -eq 0";
    const branch = code(shellBranch(step("publish", MANIFEST_STEP).run, marker));
    expect(branch).toMatch(/^\s*exit 1$/m);
    expect(branch).not.toMatch(/exit 0/);
  });

  test("the manifest step's only clean early exit is the manual-run skip", () => {
    // Any other `exit 0` here means some path publishes installers with no
    // latest.json, and the updater endpoint is
    // /releases/latest/download/latest.json: every installed copy 404s and goes
    // dark with no signal to the user or to us.
    const body = code(step("publish", MANIFEST_STEP).run);
    const skip = code(shellBranch(step("publish", MANIFEST_STEP).run, "workflow_dispatch"));
    const all = (body.match(/exit 0/g) || []).length;
    const inSkip = (skip.match(/exit 0/g) || []).length;
    expect(inSkip).toBe(1);
    expect(all).toBe(inSkip);
  });
});

// A minimal evaluator for the slice of GitHub's expression language these job
// guards use. Asserting the guard by substring would accept a broken rewrite
// (`... || true`) and reject a sound one (`event_name != 'workflow_dispatch'`),
// so evaluate it against real contexts instead. Anything outside the supported
// subset throws, which fails the test loudly: a rewritten release guard should
// be re-read by a human, not waved through.
function evalGuard(expr, ctx) {
  const tokens = [];
  const re = /\s*(&&|\|\||==|!=|[(),!]|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)/y;
  let at = 0;
  while (at < expr.length) {
    re.lastIndex = at;
    const m = re.exec(expr);
    if (!m) throw new Error(`unsupported syntax in guard at "${expr.slice(at)}"`);
    tokens.push(m[1]);
    at = re.lastIndex;
  }
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => {
    if (t && tokens[i] !== t) throw new Error(`expected ${t}, got ${tokens[i]}`);
    return tokens[i++];
  };
  const path = (p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  const FNS = {
    startsWith: (a, b) => String(a).startsWith(String(b)),
    endsWith: (a, b) => String(a).endsWith(String(b)),
    contains: (a, b) => String(a).includes(String(b)),
  };
  function primary() {
    const t = take();
    if (t === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t === "!") return !primary();
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === "true" || t === "false") return t === "true";
    if (peek() === "(") {
      if (!FNS[t]) throw new Error(`unsupported function ${t}()`);
      take("(");
      const args = [primary()];
      while (peek() === ",") {
        take(",");
        args.push(primary());
      }
      take(")");
      return FNS[t](...args);
    }
    return path(t);
  }
  function cmp() {
    const l = primary();
    if (peek() === "==" || peek() === "!=") {
      const op = take();
      const r = primary();
      return op === "==" ? l === r : l !== r;
    }
    return l;
  }
  // Both operands are evaluated into a local BEFORE combining. Short-circuiting
  // here would leave the right-hand side's tokens unconsumed and desync the
  // parser; these operands are pure lookups, so eager evaluation is free.
  function and() {
    let v = cmp();
    while (peek() === "&&") {
      take("&&");
      const r = Boolean(cmp());
      v = Boolean(v) && r;
    }
    return v;
  }
  function or() {
    let v = and();
    while (peek() === "||") {
      take("||");
      const r = Boolean(and());
      v = Boolean(v) || r;
    }
    return v;
  }
  const out = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in guard: ${tokens.slice(i).join(" ")}`);
  return Boolean(out);
}

describe("release.yml: the publish job only runs for a real tag PUSH", () => {
  const guard = (eventName, ref) => evalGuard(wf.jobs.publish.if, { github: { event_name: eventName, ref } });

  test("evalGuard understands the subset it claims to", () => {
    const ctx = { github: { event_name: "push", ref: "refs/tags/v1" } };
    expect(evalGuard("github.event_name == 'push'", ctx)).toBe(true);
    expect(evalGuard("github.event_name == 'pull_request'", ctx)).toBe(false);
    expect(evalGuard("startsWith(github.ref, 'refs/tags/')", ctx)).toBe(true);
    expect(evalGuard("startsWith(github.ref, 'refs/heads/')", ctx)).toBe(false);
    expect(evalGuard("false || (true && !false)", ctx)).toBe(true);
    expect(evalGuard("github.event_name != 'workflow_dispatch'", ctx)).toBe(true);
  });

  test("a version tag push publishes", () => {
    expect(guard("push", "refs/tags/v0.6.2")).toBe(true);
  });

  test("a branch push does not publish", () => {
    expect(guard("push", "refs/heads/001-remote-sessions-parity")).toBe(false);
  });

  test("a dispatch from a BRANCH does not publish", () => {
    expect(guard("workflow_dispatch", "refs/heads/001-remote-sessions-parity")).toBe(false);
  });

  test("a dispatch from a TAG does not publish", () => {
    // `gh workflow run --ref` takes a "Branch or tag name" and the Run-workflow
    // dropdown has a Tags tab, so github.ref can be refs/tags/vX.Y.Z on a
    // workflow_dispatch. A ref-only guard let that reach publish, and both
    // in-shell gates disarm themselves on workflow_dispatch: the version check
    // is skipped, latest.json is skipped, and the publish step renames the tag
    // to manual-<date> and ships every installer. Signed, version-unverified,
    // and with no updater manifest at all. Guard on the EVENT, not the ref.
    expect(guard("workflow_dispatch", "refs/tags/v0.6.2")).toBe(false);
  });
});

// The gates above are only half the guard. A gate that fails the job and then
// hands the maintainer a way around it has not stopped anything, and the way
// around it was written down in two places: the empty-sigs comment invited a
// hand-publish, and CLAUDE.md's release process listed `gh release create` as
// the normal fallback "when CI is flaky". Both reproduce BRS-7 by hand, because
// a local `npm run tauri build` never loads tauri.release.conf.json and so
// produces no .sig at all: no latest.json can exist, and the moment that
// release becomes /releases/latest every installed copy 404s the updater.
const WORKFLOW_TEXT = readFileSync(WORKFLOW, "utf8");
const CLAUDE_MD = fileURLToPath(new URL("../CLAUDE.md", import.meta.url));

// The leading comment block, i.e. everything above `name:`. This is what a
// maintainer reads before deciding how to ship.
const header = WORKFLOW_TEXT.slice(0, WORKFLOW_TEXT.indexOf("\nname:"));

// One `- **Bold:**` bullet out of CLAUDE.md, up to the next blank line. Throws
// rather than returning "": a renamed heading must fail loudly, not quietly
// turn every `not.toMatch` below into a pass.
function claudeBullet(label) {
  const doc = readFileSync(CLAUDE_MD, "utf8");
  const start = doc.indexOf(`- **${label}:**`);
  if (start < 0) throw new Error(`CLAUDE.md has no "- **${label}:**" bullet`);
  // CLAUDE.md is CRLF, so the blank-line terminator has to be matched as a
  // pattern. A literal two-newline search never hits there and hands back the
  // whole rest of the file, which quietly satisfies any toMatch below it.
  const rest = doc.slice(start);
  const end = rest.search(/\r?\n[ \t]*\r?\n/);
  if (end < 0) throw new Error(`the "${label}" bullet runs to EOF with no blank line after it`);
  return rest.slice(0, end);
}

// The single `::error::` line a shell branch prints. That line is the whole of
// what a maintainer sees in the Actions log, so anything the failure is supposed
// to tell them has to be IN it, not in the comment block above it. Throws rather
// than returning "": a missing message must fail loudly, not quietly turn every
// assertion about it into a pass.
function errorMessage(branch) {
  const line = code(branch)
    .split(/\r?\n/)
    .find((l) => l.includes("::error::"));
  if (!line) throw new Error("branch has no ::error:: line");
  return line;
}

describe("release.yml: the guards do not document their own bypass (BRS-7)", () => {
  test("the header does not advertise manual dispatch as a publish trigger", () => {
    // A dispatch still builds and uploads artifacts, but the publish job's `if`
    // excludes the event, so the publish half silently no-ops. Say so.
    expect(header).toMatch(/artifact/i);
    expect(header).toMatch(/never publishes|does not publish/i);
    expect(header).not.toMatch(/or run it manually from the Actions tab\./);
  });

  test("the empty-sigs failure does not hand out a path that skips the gates", () => {
    // Comments included on purpose: the invitation lived in the comment, not in
    // the ::error:: text.
    // eslint-disable-next-line no-template-curly-in-string -- shell parameter expansion, not a JS template
    const branch = shellBranch(step("publish", MANIFEST_STEP).run, "${#sigs[@]} -eq 0");
    expect(branch).not.toMatch(/gh release create/);
    // Both halves of the recovery are asserted against the MESSAGE, not against
    // the whole branch. Against the whole branch the 20-line comment above the
    // message satisfied them on its own, so deleting either one from the text a
    // maintainer actually reads left this test green.
    const message = errorMessage(branch);
    // "Re-run failed jobs" restarts only this job and re-downloads the same
    // unsigned artifacts, so the message has to name the all-jobs re-run: the
    // build leg is what must run again with the secret set.
    expect(message).toMatch(/re-run all jobs/i);
    // The one hand-published shape that cannot take the installed base dark is
    // one that never becomes /releases/latest.
    expect(message).toMatch(/prerelease/);
  });
});

describe("CLAUDE.md: the documented release path is the guarded one", () => {
  test("it does not present a bare hand-publish as the CI-flaky fallback", () => {
    const bullet = claudeBullet("Release process");
    for (const cmd of bullet.match(/gh release create[^\n]*/g) || []) {
      expect(cmd).toMatch(/--prerelease/);
    }
  });

  test("it never tells you to mark a hand-published build latest", () => {
    // `--latest` on an unsigned hand-built release is the exact trigger: the
    // updater endpoint is /releases/latest/download/latest.json.
    expect(claudeBullet("Release process")).not.toMatch(/--latest\b/);
  });

  test("it names the two assertions a hand path would otherwise skip", () => {
    const bullet = claudeBullet("Release process");
    expect(bullet).toMatch(/latest\.json/);
    expect(bullet).toMatch(/windows-x86_64/);
  });
});
