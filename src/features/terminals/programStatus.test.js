// (C)
import { describe, it, expect } from "vitest";
import {
  parseProgramStatus,
  programStatusReply,
  createStatusStore,
  applyReport,
  endInFlight,
  acknowledge,
  resetStatus,
  paneProgramStatus,
  activityFor,
  displayText,
  statusNotice,
  hasControlChar,
  MAX_BODY_BYTES,
  MAX_RECORDS,
  STATES,
} from "./programStatus.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const ch = (n) => String.fromCodePoint(n);
const report = (body) => parseProgramStatus(body)?.report;

describe("parseProgramStatus: grammar (spec rev 0.4)", () => {
  it("reads the support probe", () => {
    expect(parseProgramStatus("?")).toEqual({ query: true });
  });

  it("reads a minimal report as the root record", () => {
    expect(report("state=done")).toEqual({ state: "done", id: "" });
  });

  it("reads the spec's blocked example", () => {
    const msg = b64("Apply 3 to add, 1 to change, 0 to destroy?");
    expect(report(`state=blocked:kind=permission:app=terraform:msg=${msg}`)).toEqual({
      state: "blocked",
      id: "",
      kind: "permission",
      app: "terraform",
      msg: "Apply 3 to add, 1 to change, 0 to destroy?",
    });
  });

  it("needs a known state, and the last of a repeated key wins", () => {
    expect(parseProgramStatus("state=sleeping")).toBeNull();
    expect(parseProgramStatus("app=cargo")).toBeNull();
    expect(report("state=idle:state=working").state).toBe("working");
    for (const s of STATES) expect(report(`state=${s}`).state).toBe(s);
  });

  it("skips a malformed pair and keeps the rest", () => {
    expect(report("state=working:bad pair:progress=40")).toEqual({ state: "working", id: "", progress: 40 });
    expect(report("state=working:App=x")).toEqual({ state: "working", id: "" });
    expect(report("state=working:app=a b")).toEqual({ state: "working", id: "" });
    expect(report(" state = working : app = cargo ")).toEqual({ state: "working", id: "", app: "cargo" });
    expect(report("state=working:sixteencharskey=x")).toEqual({ state: "working", id: "" });
  });

  it("takes an id path, and ignores the whole report for a bad one", () => {
    expect(report("state=working:id=deploy/us-east").id).toBe("deploy/us-east");
    expect(parseProgramStatus("state=working:id=a//b")).toBeNull();
    expect(parseProgramStatus("state=working:id=")).toBeNull();
    expect(parseProgramStatus("state=working:id=" + "a/".repeat(8) + "a")).toBeNull();
    expect(parseProgramStatus("state=working:id=" + "a".repeat(33))).toBeNull();
    expect(report("state=working:id=" + "a".repeat(32)).id).toBe("a".repeat(32));
  });

  it("keeps kind for blocked only, and progress for working or blocked, 0 to 100", () => {
    expect(report("state=working:kind=permission").kind).toBeUndefined();
    expect(report("state=blocked:kind=vote").kind).toBeUndefined();
    expect(report("state=blocked:kind=auth").kind).toBe("auth");
    expect(report("state=done:progress=40").progress).toBeUndefined();
    expect(report("state=working:progress=101").progress).toBeUndefined();
    expect(report("state=working:progress=40.5").progress).toBeUndefined();
    expect(report("state=blocked:progress=0").progress).toBe(0);
    expect(report("state=working:progress=100").progress).toBe(100);
  });

  it("discards the whole report when its text is not clean base64 UTF-8", () => {
    expect(parseProgramStatus("state=done:msg=" + b64("line1" + ch(10) + "line2"))).toBeNull();
    expect(parseProgramStatus("state=done:msg=" + b64("tab" + ch(9)))).toBeNull();
    expect(parseProgramStatus("state=done:msg=" + b64("esc" + ch(27) + "[2J"))).toBeNull();
    expect(parseProgramStatus("state=done:msg=" + b64("c1" + ch(0x85)))).toBeNull();
    expect(parseProgramStatus("state=done:msg=" + Buffer.from([0xff, 0xfe]).toString("base64"))).toBeNull();
    expect(parseProgramStatus("state=done:msg=abc-_")).toBeNull();
    expect(parseProgramStatus("state=done:msg=QQ=A")).toBeNull();
    // A value outside the grammar is a malformed pair, skipped, not a discard.
    expect(report("state=done:msg=@@@")).toEqual({ state: "done", id: "" });
  });

  it("accepts base64 with or without padding", () => {
    expect(report("state=done:msg=SGk=").msg).toBe("Hi");
    expect(report("state=done:msg=SGk").msg).toBe("Hi");
    expect(report("state=done:title=" + b64("Build")).title).toBe("Build");
  });

  it("holds to the size limits", () => {
    expect(parseProgramStatus("state=done:app=x:" + "a".repeat(MAX_BODY_BYTES))).toBeNull();
    expect(parseProgramStatus("state=done:msg=" + b64("x".repeat(2049)))).toBeNull();
    expect(report("state=done:msg=" + b64("x".repeat(2048))).msg.length).toBe(2048);
    expect(parseProgramStatus("state=done:title=" + b64("x".repeat(193)))).toBeNull();
    expect(report("state=done:title=" + b64("x".repeat(192))).title.length).toBe(192);
    expect(report("state=done:app=" + "a".repeat(32)).app).toBe("a".repeat(32));
    const body = (n) => {
      const head = "state=done:z=";
      return head + "a".repeat(n - head.length);
    };
    expect(report(body(MAX_BODY_BYTES)).state).toBe("done");
    expect(parseProgramStatus(body(MAX_BODY_BYTES + 1))).toBeNull();
  });

  it("discards the whole report for anything over a limit, even a repeated key's earlier value", () => {
    expect(parseProgramStatus("state=working:seventeencharskey=x")).toBeNull();
    expect(parseProgramStatus("state=done:app=" + "a".repeat(33))).toBeNull();
    expect(parseProgramStatus("state=done:msg=" + "QUFB".repeat(684) + ":msg=SGk=")).toBeNull();
    expect(parseProgramStatus("state=done:title=" + "QUFB".repeat(65) + ":title=SGk=")).toBeNull();
    expect(parseProgramStatus("state=done:id=" + "a/".repeat(64) + "a")).toBeNull();
    // An app outside the grammar but inside the limit is only left out.
    expect(report("state=done:app=a,b")).toEqual({ state: "done", id: "" });
  });

  it("refuses non-string input", () => {
    expect(parseProgramStatus(undefined)).toBeNull();
    expect(parseProgramStatus(7501)).toBeNull();
  });
});

describe("programStatusReply", () => {
  it("is the fixed probe reply and nothing else", () => {
    expect(programStatusReply()).toBe(ch(27) + "]7501;?" + ch(27) + ch(92));
  });
});

describe("records", () => {
  const apply = (store, body) => applyReport(store, report(body));

  it("replaces a record whole", () => {
    const s = createStatusStore();
    apply(s, "state=working:progress=40:app=cargo");
    apply(s, "state=working");
    expect(paneProgramStatus(s)).toEqual({ state: "working", id: "" });
  });

  it("clears a subtree, or everything", () => {
    const s = createStatusStore();
    apply(s, "state=working:id=a");
    apply(s, "state=blocked:id=a/b");
    apply(s, "state=working:id=ab");
    apply(s, "state=clear:id=a");
    expect([...s.records.keys()]).toEqual(["ab"]);
    apply(s, "state=done");
    apply(s, "state=clear");
    expect(s.records.size).toBe(0);
  });

  it("evicts the least recently updated past the cap, never the newest", () => {
    const s = createStatusStore();
    for (let i = 0; i <= MAX_RECORDS; i++) apply(s, `state=working:id=r${i}`);
    expect(s.records.size).toBe(MAX_RECORDS);
    expect(s.records.has("r0")).toBe(false);
    expect(s.records.has(`r${MAX_RECORDS}`)).toBe(true);
    apply(s, "state=working:id=r1");
    apply(s, "state=working:id=extra");
    expect(s.records.has("r1")).toBe(true);
    expect(s.records.has("r2")).toBe(false);
  });

  it("speaks for the pane with the most urgent record, the latest on a tie", () => {
    const s = createStatusStore();
    apply(s, "state=blocked:id=eu-west:kind=question");
    apply(s, "state=working:id=us-east:progress=40");
    expect(paneProgramStatus(s)).toMatchObject({ state: "blocked", id: "eu-west", kind: "question" });
    apply(s, "state=blocked:id=ap-south:kind=auth");
    expect(paneProgramStatus(s).id).toBe("ap-south");
    apply(s, "state=error:id=eu-west");
    apply(s, "state=done:id=ap-south");
    expect(paneProgramStatus(s).state).toBe("error");
  });

  it("lends a child the app of its nearest ancestor", () => {
    const s = createStatusStore();
    apply(s, "state=working:app=deploy");
    apply(s, "state=blocked:id=a/b");
    expect(paneProgramStatus(s)).toMatchObject({ state: "blocked", app: "deploy" });
  });

  it("ends what was in flight, keeps finished runs until seen", () => {
    const s = createStatusStore();
    apply(s, "state=working:id=a");
    apply(s, "state=blocked:id=b");
    apply(s, "state=idle:id=c");
    apply(s, "state=done:id=d");
    apply(s, "state=error:id=e");
    endInFlight(s);
    expect([...s.records.keys()].sort()).toEqual(["d", "e"]);
    acknowledge(s);
    expect(s.records.size).toBe(0);
    apply(s, "state=working");
    resetStatus(s);
    expect(paneProgramStatus(s)).toBeNull();
  });
});

describe("activityFor", () => {
  it("maps program states onto pane activity", () => {
    expect(activityFor(null)).toBeNull();
    expect(activityFor({ state: "blocked" })).toBe("waiting");
    expect(activityFor({ state: "working" })).toBe("active");
    expect(activityFor({ state: "done" })).toBe("done");
    expect(activityFor({ state: "error" })).toBe("done");
    expect(activityFor({ state: "idle" })).toBe("idle");
  });
});

describe("displayText", () => {
  it("drops direction overrides, invisible and control characters, and cuts long text", () => {
    expect(displayText("Approve " + ch(0x202e) + "txt.exe")).toBe("Approve txt.exe");
    expect(displayText("a" + ch(0x200b) + "b" + ch(0xfeff) + "c" + ch(0x2066))).toBe("abc");
    expect(displayText("x" + ch(27) + "y" + ch(0x85))).toBe("xy");
    expect(displayText("z".repeat(200), 10)).toBe("z".repeat(9) + "…");
    expect(displayText(undefined)).toBe("");
  });
});

describe("fuzz: no input throws or yields a record outside the spec", () => {
  it("holds for 20,000 random bodies", () => {
    const alphabet = "abcdefgstateidworkingblockedonekprmsqutionapAZ019+/=-_.,:; ?" + ch(0xe9) + ch(0x202e) + ch(10);
    let seed = 7501;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = () => alphabet[rand(alphabet.length)];
    const pieces = ["state=", "working", "blocked", "done", "idle", "error", "clear", "id=", "kind=", "permission", "progress=", "app=", "msg=", "title=", ":", "/", b64("hi"), b64("x" + ch(10))];
    for (let i = 0; i < 20000; i++) {
      let body = "";
      const n = rand(12);
      for (let j = 0; j < n; j++) body += rand(2) ? pieces[rand(pieces.length)] : pick();
      const out = parseProgramStatus(body);
      if (!out || out.query) continue;
      const r = out.report;
      expect(STATES).toContain(r.state);
      if (r.id) expect(r.id.split("/").every((seg) => seg.length >= 1 && seg.length <= 32)).toBe(true);
      for (const key of ["msg", "title"]) if (r[key] !== undefined) expect(hasControlChar(r[key])).toBe(false);
      if (r.progress !== undefined) expect(r.progress >= 0 && r.progress <= 100).toBe(true);
    }
  });
});

describe("statusNotice", () => {
  it("labels a program's message as the program's", () => {
    expect(statusNotice({ state: "blocked", app: "terraform", msg: "Apply?" }, "needs_you")).toBe("terraform says: Apply?");
    expect(statusNotice({ state: "blocked", msg: "Apply?" }, "needs_you")).toBe("The program says: Apply?");
    expect(statusNotice({ state: "blocked", app: "x" + ch(0x202e), msg: "a" + ch(0x200b) + "b" }, "needs_you")).toBe("x says: ab");
  });

  it("uses the app's own words otherwise", () => {
    expect(statusNotice(null, "needs_you")).toBe("Waiting for your approval");
    expect(statusNotice({ state: "blocked", kind: "question", app: "claude-code" }, "needs_you")).toBe("claude-code has a question for you");
    expect(statusNotice({ state: "blocked", kind: "auth" }, "needs_you")).toBe("The program asks you to sign in");
    expect(statusNotice(null, "finished")).toBe("Done");
    expect(statusNotice({ state: "error", app: "cargo" }, "finished")).toBe("cargo stopped with an error");
  });
});
