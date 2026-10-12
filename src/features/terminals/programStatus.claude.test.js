// (C)
// Conformance with Claude Code, the first program to send OSC 7501. The
// encoder below copies Claude Code 2.1.295's own (read from its binary on
// 2026-10-12): `state` then `app=claude-code`, then id, kind, progress, and
// title and msg as base64 of text whose C0, DEL and C1 characters became
// spaces, cut to 192 and 2048 UTF-8 bytes on a character boundary. Ids are
// background task ids with anything outside [A-Za-z0-9_.+-] made a dash, cut
// to 32. It sends `state=clear` on exit and `state=clear:id=<id>` when a task
// goes. If Claude Code changes its format, update this copy from the new
// binary; do not loosen the parser to make a guess pass.

import { describe, it, expect } from "vitest";
import {
  parseProgramStatus,
  createStatusStore,
  applyReport,
  paneProgramStatus,
  MAX_BODY_BYTES,
  MAX_RECORDS,
} from "./programStatus.js";

const ch = (n) => String.fromCodePoint(n);
const CONTROLS = new RegExp("[" + ch(0) + "-" + ch(0x1f) + ch(0x7f) + "-" + ch(0x9f) + "]", "g");

function cutBytes(text, max) {
  if (text.length * 3 <= max) return text;
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(max));
  return text.slice(0, read);
}

function claudeText(text, max) {
  return cutBytes(text.replace(CONTROLS, " "), max);
}

function claudeId(raw) {
  const id = raw.replace(/[^A-Za-z0-9_.+-]/g, "-").slice(0, 32);
  return id.length > 0 ? id : undefined;
}

// Claude Code's report body (what follows `7501;`).
function claudeReport(e) {
  const parts = [`state=${e.state}`, "app=claude-code"];
  if (e.id !== undefined) parts.push(`id=${e.id}`);
  if (e.state === "blocked" && e.kind) parts.push(`kind=${e.kind}`);
  if ((e.state === "working" || e.state === "blocked") && e.progress !== undefined && Number.isFinite(e.progress)) {
    parts.push(`progress=${Math.min(100, Math.max(0, Math.round(e.progress)))}`);
  }
  if (e.title) parts.push(`title=${Buffer.from(claudeText(e.title, 192)).toString("base64")}`);
  if (e.msg) parts.push(`msg=${Buffer.from(claudeText(e.msg, 2048)).toString("base64")}`);
  return parts.join(":");
}

// What the receiver should decode: the cut text as UTF-8 round-trips it
// (a lone surrogate becomes U+FFFD on the way out).
const decoded = (text, max) => Buffer.from(claudeText(text, max)).toString("utf8");

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = [
  "a", "q", "Z", "0", "7", " ", ".", ":", "=", ";", "/", "-",
  ch(10), ch(9), ch(13), ch(27), ch(0), ch(0x7f), ch(0x85), ch(0x9b),
  ch(0xe9), ch(0x301), ch(0x4e2d), ch(0x1f600), ch(0x202e), ch(0x200b), ch(0x2028), ch(0xfeff), ch(0xd800),
];

function randomText(next, maxLen) {
  const n = Math.floor(next() * maxLen);
  let s = "";
  for (let i = 0; i < n; i++) s += POOL[Math.floor(next() * POOL.length)];
  return s;
}

const pick = (next, list) => list[Math.floor(next() * list.length)];

describe("Claude Code 2.1.295 reports", () => {
  it("parses everything Claude Code can send, fields intact (5,000 cases)", () => {
    const next = rng(7501);
    for (let i = 0; i < 5000; i++) {
      const e = {
        state: pick(next, ["idle", "working", "blocked", "done", "error"]),
        id: next() < 0.5 ? undefined : claudeId(randomText(next, 48)),
        kind: pick(next, ["permission", "question", "auth", undefined]),
        progress: pick(next, [undefined, Number.NaN, next() * 200 - 50]),
        title: next() < 0.3 ? undefined : randomText(next, next() < 0.2 ? 400 : 40),
        msg: next() < 0.3 ? undefined : randomText(next, next() < 0.2 ? 3000 : 120),
      };
      const body = claudeReport(e);
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
      const parsed = parseProgramStatus(body);
      expect(parsed, body.slice(0, 120)).not.toBeNull();
      const r = parsed.report;
      expect(r.state).toBe(e.state);
      expect(r.app).toBe("claude-code");
      expect(r.id).toBe(e.id ?? "");
      expect(r.kind).toBe(e.state === "blocked" && e.kind ? e.kind : undefined);
      const hasProgress = (e.state === "working" || e.state === "blocked") && Number.isFinite(e.progress);
      expect(r.progress).toBe(hasProgress ? Number(`${Math.min(100, Math.max(0, Math.round(e.progress)))}`) : undefined);
      expect(r.title).toBe(e.title ? decoded(e.title, 192) : undefined);
      expect(r.msg).toBe(e.msg ? decoded(e.msg, 2048) : undefined);
    }
  });

  it("takes the longest title and message Claude Code sends", () => {
    const body = claudeReport({ state: "blocked", kind: "permission", title: ch(0x1f600).repeat(200), msg: ch(0x4e2d).repeat(1000) });
    const r = parseProgramStatus(body).report;
    expect(new TextEncoder().encode(r.title).length).toBe(192);
    expect(new TextEncoder().encode(r.msg).length).toBe(2046);
  });

  it("a dialog with no kind still reads as blocked", () => {
    expect(parseProgramStatus(claudeReport({ state: "blocked", msg: "dialog open" })).report).toEqual({
      state: "blocked",
      id: "",
      app: "claude-code",
      msg: "dialog open",
    });
  });

  it("follows a session: tasks come and go, and the exit clears all of it", () => {
    const store = createStatusStore();
    const send = (body) => applyReport(store, parseProgramStatus(body).report);
    send(claudeReport({ state: "working", msg: "Reading files" }));
    const tasks = Array.from({ length: 32 }, (_, i) => `b${String(i).padStart(2, "0")}a7f`);
    for (const id of tasks) send(claudeReport({ state: "working", id, title: `task ${id}` }));
    expect(store.records.size).toBe(33);
    expect(store.records.size).toBeLessThanOrEqual(MAX_RECORDS);
    send(claudeReport({ state: "blocked", id: tasks[5], kind: "question" }));
    expect(paneProgramStatus(store)).toMatchObject({ state: "blocked", kind: "question", app: "claude-code" });
    send(`state=clear:id=${tasks[5]}`);
    expect(paneProgramStatus(store).state).toBe("working");
    send(claudeReport({ state: "done", msg: "All tests pass" }));
    expect(store.records.get("").state).toBe("done");
    send("state=clear");
    expect(store.records.size).toBe(0);
    expect(paneProgramStatus(store)).toBeNull();
  });
});
