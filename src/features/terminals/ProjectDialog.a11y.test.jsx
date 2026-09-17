// (C)
// @vitest-environment happy-dom
// A11Y-10, sites 15 through 25 of 25. The connect-modal pass closed 14 sites
// and left eleven here, in the one dialog that reaches every session type.
//
// THE BUG. Every caption in ProjectDialog was a <label> with no htmlFor
// wrapping no control. A screen-reader user opening Sessions -> Add session
// heard four to eight anonymous "edit" fields in a row with nothing to tell
// Host from Port from Name, and clicking the word "HOST" focused nothing,
// which is the standard behaviour of every other Windows dialog. Ten of the
// eleven are now label[for] + id. The eleventh, AUTHENTICATION, captions three
// <button>s rather than one control, so it stopped being a <label> at all and
// became a caption naming a role="group".
//
// WHY IT IS TESTED THIS WAY. The resolver below walks the RENDERED DOM and
// computes each control's accessible name the way the platform does:
// aria-label, then aria-labelledby, then a label[for] that actually points at
// this element's id, then a wrapping <label>, then, for buttons only, its own
// content. It is a deliberate copy of the connect-modal harness rather than an
// import from it, so this file cannot pass by agreeing with app code, and the
// two suites stay independently killable. The strong assertion is the EXACT
// ORDERED SET of names per session type: adding a field without labelling it
// fails, deleting one and leaving a stale row here fails, and cross-wiring two
// htmlFor values passes an existence check but fails the focus test.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import ProjectDialog from "./ProjectDialog.jsx";

const byId = (root, id) => [...root.querySelectorAll("[id]")].find((n) => n.id === id) || null;
const text = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : "");

/**
 * Roles for which the accname spec marks name-from-author PROHIBITED, so the
 * platform skips steps 2A and 2B and throws any computed name away. `generic`
 * is the one that matters: it is what a bare <div> or <span> maps to, which
 * makes aria-labelledby on a role-less <div> a silent no-op and an axe-core
 * `aria-prohibited-attr` violation. Modelling it is the difference between a
 * helper that measures the platform and one that rubber-stamps whatever the
 * component happened to write.
 */
const NAME_FROM_AUTHOR_PROHIBITED = new Set(["generic", "presentation", "none", "paragraph"]);
/** Tags whose IMPLICIT role is one of the above, i.e. where omitting `role` IS the defect. */
const IMPLICITLY_GENERIC = new Set(["DIV", "SPAN", "P", "PRE", "B", "I", "U", "SMALL"]);

function nameFromAuthorAllowed(el) {
  const role = (el.getAttribute("role") || "").trim().toLowerCase();
  if (role) return !NAME_FROM_AUTHOR_PROHIBITED.has(role);
  return !IMPLICITLY_GENERIC.has(el.tagName);
}

function accessibleName(el, root) {
  if (nameFromAuthorAllowed(el)) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const joined = labelledby.split(/\s+/).map((id) => text(byId(root, id))).join(" ").trim();
      if (joined) return joined;
    }
  }

  if (el.id) {
    const lab = [...root.querySelectorAll("label[for]")].find((l) => l.getAttribute("for") === el.id);
    if (lab) return text(lab);
  }

  const wrapping = el.closest("label");
  if (wrapping) return text(wrapping);

  if (/^(button|a)$/i.test(el.tagName)) {
    const own = text(el);
    if (own) return own;
  }
  return "";
}

const namesOf = (selector, root = document.body) =>
  [...root.querySelectorAll(selector)].map((el) => accessibleName(el, root));

/**
 * A <label> that names nothing is an orphan: assistive tech announces it as
 * loose text and clicking it focuses nothing. Returns the offending captions.
 */
const orphanLabels = (root = document.body) =>
  [...root.querySelectorAll("label")]
    .filter((l) => {
      const f = l.getAttribute("for");
      if (f) return byId(root, f) === null;
      return l.querySelector("input, select, textarea") === null;
    })
    .map(text);

/**
 * Every text field and multi-line field, in document order. Excludes the one
 * checkbox, whose wrapping <label> carries three sentences of help text.
 */
const TEXT_FIELDS = 'input:not([type="checkbox"]), textarea';

const show = (initial) =>
  render(<ProjectDialog open initial={initial} onSave={() => {}} onClose={() => {}} />);

const captionFor = (caption) => {
  const lab = [...document.querySelectorAll("label")].find((l) => text(l) === caption);
  return lab ? byId(document.body, lab.getAttribute("for")) : null;
};

beforeEach(() => invokeMock.mockReset());
afterEach(cleanup);

describe("ProjectDialog field labelling (A11Y-10)", () => {
  test("local: every field is programmatically named", () => {
    show(null);
    expect(namesOf(TEXT_FIELDS)).toEqual([
      "Path",
      "Name",
      "Folder (optional)",
      "Tags (optional)",
      "Start commands (optional, one per line)",
    ]);
  });

  test("ssh with key auth: every field is programmatically named", () => {
    show({ type: "ssh", connection: { host: "box", user: "root", auth: { method: "key" } } });
    expect(namesOf(TEXT_FIELDS)).toEqual([
      "Host",
      "Port",
      "Username",
      "Private key path",
      "Name",
      "Folder (optional)",
      "Tags (optional)",
      "Commands to run after connect (optional, one per line)",
    ]);
  });

  test("rdp: every field is programmatically named, Domain included", () => {
    show({ type: "rdp", rdp: { host: "box" } });
    expect(namesOf(TEXT_FIELDS)).toEqual([
      "Host",
      "Port",
      "Username (optional)",
      "Domain (optional)",
      "Name",
      "Folder (optional)",
      "Tags (optional)",
    ]);
  });

  test("vnc: every field is programmatically named", () => {
    show({ type: "vnc", vnc: { host: "box" } });
    expect(namesOf(TEXT_FIELDS)).toEqual([
      "Host",
      "Port",
      "Name",
      "Folder (optional)",
      "Tags (optional)",
    ]);
  });

  test("the auto-approve checkbox is named by the label wrapping it", () => {
    show(null);
    const box = document.querySelector('input[type="checkbox"]');
    expect(accessibleName(box, document.body)).toContain("Auto-approve permission prompts");
  });

  test.each([
    ["local", null],
    ["ssh", { type: "ssh", connection: { host: "box", user: "root", auth: { method: "key" } } }],
    ["rdp", { type: "rdp", rdp: { host: "box" } }],
    ["vnc", { type: "vnc", vnc: { host: "box" } }],
  ])("%s: no caption points at a control that is not there", (_label, initial) => {
    show(initial);
    expect(orphanLabels()).toEqual([]);
  });
});

describe("ProjectDialog caption-to-field wiring (A11Y-10)", () => {
  test("ssh: clicking a caption focuses its own field, not a neighbour", () => {
    // Eight distinct values. Cross-wiring any two htmlFor attributes still
    // passes the naming tests above and fails here, which is the property
    // htmlFor actually buys a sighted user.
    show({
      type: "ssh",
      name: "prod-box",
      folder: "Production",
      tags: ["db", "eu-west"],
      startCommands: ["tmux attach"],
      connection: {
        host: "10.0.0.9",
        port: 2222,
        user: "deploy",
        auth: { method: "key", keyPath: "~/.ssh/id_deploy" },
      },
    });
    expect(captionFor("Host").value).toBe("10.0.0.9");
    expect(captionFor("Port").value).toBe("2222");
    expect(captionFor("Username").value).toBe("deploy");
    expect(captionFor("Private key path").value).toBe("~/.ssh/id_deploy");
    expect(captionFor("Name").value).toBe("prod-box");
    expect(captionFor("Folder (optional)").value).toBe("Production");
    expect(captionFor("Tags (optional)").value).toBe("db, eu-west");

    const commands = captionFor("Commands to run after connect (optional, one per line)");
    expect(commands.tagName).toBe("TEXTAREA");
    expect(commands.value).toBe("tmux attach");
  });

  test("local: PATH points at the path box and not at the Browse button", () => {
    // The Browse button shares the row, which is why this caption uses
    // htmlFor rather than wrapping its control: a wrapping label would make a
    // Browse click a label activation too.
    show({ type: "local", name: "app", path: "C:\\srv\\app" });
    const target = captionFor("Path");
    expect(target.tagName).toBe("INPUT");
    expect(target.value).toBe("C:\\srv\\app");
  });

  test("rdp: Domain and Username are not cross-wired", () => {
    show({ type: "rdp", rdp: { host: "box", username: "Administrator", domain: "CORP" } });
    expect(captionFor("Username (optional)").value).toBe("Administrator");
    expect(captionFor("Domain (optional)").value).toBe("CORP");
  });
});

describe("ProjectDialog authentication group (A11Y-10)", () => {
  const ssh = { type: "ssh", connection: { host: "box", user: "root", auth: { method: "password" } } };

  test("the caption names the button group instead of pretending to be a label", () => {
    show(ssh);
    // It used to be a <label> with nothing to label: a label names ONE control
    // and there are three buttons here, so it named nothing at all.
    expect(orphanLabels()).toEqual([]);
    const group = document.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(accessibleName(group, document.body)).toBe("Authentication");
  });

  test("the group's role is load-bearing, not decoration", () => {
    show(ssh);
    const group = document.querySelector('[role="group"]');
    // A bare <div> maps to role=generic, which PROHIBITS name-from-author, so
    // the platform would discard this aria-labelledby and the row would go back
    // to being an unnamed cluster of buttons. Strip the role and the resolver
    // returns "" exactly like Chromium does.
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-labelledby")).toBeTruthy();
    group.removeAttribute("role");
    expect(accessibleName(group, document.body)).toBe("");
  });

  test("the group holds the three auth choices", () => {
    show(ssh);
    const group = document.querySelector('[role="group"]');
    expect(namesOf("button", group)).toEqual(["Password", "Private key", "SSH agent"]);
  });
});

describe("ProjectDialog id generation (A11Y-10)", () => {
  test("two dialogs in one document do not share field ids", () => {
    // The ids come from useId, not literals. Literal ids would make the second
    // dialog's captions focus the FIRST dialog's fields, because label[for]
    // resolves to the first matching id in the document.
    show({ type: "ssh", connection: { host: "a", user: "u", auth: { method: "key" } } });
    const first = [...document.querySelectorAll("label[for]")].map((l) => l.getAttribute("for"));
    show({ type: "ssh", connection: { host: "b", user: "u", auth: { method: "key" } } });
    const all = [...document.querySelectorAll("label[for]")].map((l) => l.getAttribute("for"));

    expect(first.length).toBe(8);
    expect(all.length).toBe(16);
    expect(new Set(all).size).toBe(16);
  });
});
