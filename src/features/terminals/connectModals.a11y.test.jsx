// (C)
// @vitest-environment happy-dom
// A11Y-10 + A11Y-02: every control on the connect surface has to carry a
// programmatic name, not just a caption sitting next to it in pixel space.
//
// THE BUG. Twenty-five <label> elements across the connect modals had neither
// htmlFor nor a wrapped input, and the inputs had no id, aria-label or
// aria-labelledby. A screen-reader user opening Sessions -> RDP heard five
// anonymous "edit" fields in a row, one of them "protected edit", with no way
// to tell Host from Port from Domain. Sighted users hit the smaller version:
// clicking the word "Host" did not focus Host, which is the standard behaviour
// of every other Windows dialog.
//
// WHY IT IS TESTED THIS WAY. The assertion walks the RENDERED DOM of the real
// modals and resolves each control's accessible name the way the platform does
// aria-label, then aria-labelledby, then a label[for] that actually points at
// this element's id, then a wrapping <label>, then, for buttons only, its own
// content. Nothing here imports or mirrors app code, so it cannot pass by
// agreeing with a copy of the thing it guards. The strong assertion is the
// EXACT SET of names per modal: adding a field without labelling it fails, and
// so does deleting a field and leaving a stale row here.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,x") } }));

import RdpConnectModal from "./RdpConnectModal.jsx";
import VncConnectModal from "./VncConnectModal.jsx";
import TunnelsModal from "./TunnelsModal.jsx";
import RemoteControlModal from "./RemoteControlModal.jsx";
import SerialModal from "./SerialModal.jsx";
import ProjectSidebar from "./ProjectSidebar.jsx";

const byId = (root, id) => [...root.querySelectorAll("[id]")].find((n) => n.id === id) || null;
const text = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : "");

/**
 * Roles for which the accname spec marks name-from-author PROHIBITED, so the
 * platform skips steps 2A and 2B and discards any computed name. `generic` is
 * the one that matters here: it is what a bare <div> or <span> maps to, which
 * makes `aria-labelledby` on a role-less <div> a silent no-op and an axe-core
 * `aria-prohibited-attr` violation. Modelling that is the difference between a
 * helper that measures the platform and one that certifies whatever the
 * component happened to write: an ungated resolver greenlights exactly the
 * markup the platform throws away.
 */
const NAME_FROM_AUTHOR_PROHIBITED = new Set(["generic", "presentation", "none", "paragraph"]);
/** Tags whose IMPLICIT role is one of the above, i.e. where omitting `role` IS the defect. */
const IMPLICITLY_GENERIC = new Set(["DIV", "SPAN", "P", "PRE", "B", "I", "U", "SMALL"]);

function nameFromAuthorAllowed(el) {
  const role = (el.getAttribute("role") || "").trim().toLowerCase();
  if (role) return !NAME_FROM_AUTHOR_PROHIBITED.has(role);
  return !IMPLICITLY_GENERIC.has(el.tagName);
}

/**
 * The accessible name of `el`, in the precedence order the accname spec uses
 * for the subset of markup this app writes. Deliberately hand-rolled and
 * deliberately strict: it does NOT fall back to `title`, because a <button>'s
 * own text content wins over title, which is exactly the trap the glyph
 * buttons ("+", "<<", "<") fell into.
 */
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

beforeEach(() => invokeMock.mockReset());
afterEach(cleanup);

describe("RdpConnectModal field labelling (A11Y-10)", () => {
  test("all five fields are programmatically named", () => {
    render(<RdpConnectModal open onConnect={() => {}} onClose={() => {}} />);
    expect(namesOf("input")).toEqual([
      "Host", "Port", "Username", "Domain (optional)", "Password",
    ]);
  });

  test("no caption points at a control that is not there", () => {
    render(<RdpConnectModal open onConnect={() => {}} onClose={() => {}} />);
    expect(orphanLabels()).toEqual([]);
  });

  test("clicking a caption focuses its own field, not a neighbour", () => {
    // The sighted half of the finding, and the property htmlFor actually buys:
    // each caption resolves to the input holding that field's value.
    render(<RdpConnectModal open initial={{ host: "10.0.0.9", port: 3390, username: "admin", domain: "CORP" }} lockConnection onConnect={() => {}} onClose={() => {}} />);
    const target = (caption) => {
      const lab = [...document.querySelectorAll("label")].find((l) => text(l) === caption);
      return byId(document.body, lab.getAttribute("for"));
    };
    expect(target("Host").value).toBe("10.0.0.9");
    expect(target("Port").value).toBe("3390");
    expect(target("Username").value).toBe("admin");
    expect(target("Domain (optional)").value).toBe("CORP");
    expect(target("Password").type).toBe("password");
  });
});

describe("VncConnectModal field labelling (A11Y-10)", () => {
  test("all three fields are programmatically named", () => {
    render(<VncConnectModal open onConnect={() => {}} onClose={() => {}} />);
    expect(namesOf("input")).toEqual(["Host", "Port", "Password (if required)"]);
  });

  test("no orphan captions", () => {
    render(<VncConnectModal open onConnect={() => {}} onClose={() => {}} />);
    expect(orphanLabels()).toEqual([]);
  });
});

describe("TunnelsModal labelling (A11Y-10)", () => {
  const forwards = [
    { id: "f1", localPort: 8080, remoteHost: "localhost", remotePort: 5432 },
    { id: "f2", localPort: 1080, socks: true },
  ];

  test("all four fields are programmatically named", () => {
    render(<TunnelsModal open host="box" user="pluto" onClose={() => {}} />);
    expect(namesOf("input")).toEqual(["Local port", "Remote host", "Remote port", "SOCKS port"]);
  });

  test("'Active forwards' captions the list instead of pretending to be a label", () => {
    render(<TunnelsModal open host="box" user="pluto" forwards={forwards} onClose={() => {}} />);
    // It used to be a <label> with nothing to label. It must still be on
    // screen (it is the only thing that names the list) but must no longer be
    // a label element.
    expect(orphanLabels()).toEqual([]);
    const list = document.querySelector('[role="list"]');
    expect(accessibleName(list, document.body)).toBe("Active forwards");
  });

  test("each Stop button says which forward it stops", () => {
    render(<TunnelsModal open host="box" user="pluto" forwards={forwards} onClose={() => {}} />);
    // Two buttons both reading "Stop" is a coin flip for a screen-reader user,
    // and stopping the wrong one drops a live tunnel.
    const stops = [...document.querySelectorAll("button")]
      .filter((b) => text(b) === "Stop")
      .map((b) => accessibleName(b, document.body));
    expect(stops).toEqual([
      "Stop forward on local port 8080",
      "Stop forward on local port 1080",
    ]);
    expect(new Set(stops).size).toBe(stops.length);
  });
});

describe("SerialModal field labelling (A11Y-10)", () => {
  // Sites 12 and 13 of the finding's 25, in a file the first pass missed
  // entirely. The remaining eleven are ProjectDialog.jsx, owned by another
  // stream this batch and carried on the residual list by file:line.
  async function mountWithPorts() {
    invokeMock.mockResolvedValue(["COM3", "COM7"]);
    const view = render(<SerialModal open onConnect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll("option").length).toBeGreaterThan(1));
    await act(async () => {});
    return view;
  }

  test("both pickers are programmatically named", async () => {
    await mountWithPorts();
    expect(namesOf("select")).toEqual(["Port", "Baud"]);
  });

  test("no caption points at a control that is not there", async () => {
    await mountWithPorts();
    expect(orphanLabels()).toEqual([]);
  });

  test("clicking a caption focuses its own picker, not a neighbour", async () => {
    await mountWithPorts();
    const target = (caption) => {
      const lab = [...document.querySelectorAll("label")].find((l) => text(l) === caption);
      return byId(document.body, lab.getAttribute("for"));
    };
    // Port holds a COM path, Baud holds a number: cross-wiring the two htmlFor
    // values passes an existence check and fails this one.
    expect(target("Port").value).toBe("COM3");
    expect(target("Baud").value).toBe("115200");
  });

  test("the rescan control announces words, not a glyph", async () => {
    await mountWithPorts();
    // For a <button> its own content beats title, so "⟳" was the whole name.
    const rescan = [...document.querySelectorAll("button")].find((b) => text(b) === "⟳");
    expect(accessibleName(rescan, document.body)).toBe("Rescan ports");
  });
});

describe("RemoteControlModal control naming (A11Y-10)", () => {
  const running = { running: true, url: "http://box:8390/", token: "abc123", host: "box", port: 8390 };

  async function mountRunning() {
    invokeMock.mockResolvedValue(running);
    const view = render(<RemoteControlModal open onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll("button").length).toBeGreaterThan(2));
    await act(async () => {});
    return view;
  }

  test("the two Copy buttons name what they copy", async () => {
    await mountRunning();
    const copies = [...document.querySelectorAll("button")]
      .filter((b) => text(b) === "Copy")
      .map((b) => accessibleName(b, document.body));
    // Both used to announce as the bare word "Copy", and the pairing URL and the
    // bearer token are the entire content of this screen.
    expect(copies).toEqual(["Copy Link", "Copy Access token"]);
  });

  test("the value boxes are named by their captions", async () => {
    await mountRunning();
    // Scoped past the dialog element, which carries its own aria-labelledby.
    const wells = [...document.querySelectorAll('[role="dialog"] div[aria-labelledby]')];
    // The role is not decoration. A bare <div> maps to role=generic, which
    // PROHIBITS name-from-author, so the platform discards the aria-labelledby
    // and the box goes back to being an unnamed blob holding the pairing URL
    // and the bearer token. Strip the role and accessibleName() now returns ""
    // exactly like Chromium does, which is the whole reason it gained a role
    // gate.
    expect(wells.map((el) => el.getAttribute("role"))).toEqual(["group", "group"]);
    expect(wells.map((el) => [accessibleName(el, document.body), text(el)]))
      .toEqual([["Link", "http://box:8390/"], ["Access token", "abc123"]]);
  });

  test("the dialog is a dialog and the close control is not named after a glyph", async () => {
    await mountRunning();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(accessibleName(dialog, document.body)).toBe("Remote control");
    // aria-modal is deliberately absent: this modal has no focus trap, and
    // claiming one would lie to assistive tech. See the residual list.
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    const close = [...document.querySelectorAll("button")].find((b) => text(b) === "✕");
    expect(accessibleName(close, document.body)).toBe("Close");
  });
});

describe("ProjectSidebar header controls (A11Y-02)", () => {
  const sidebar = (props) =>
    render(<ProjectSidebar projects={[]} onAddProject={() => {}} {...props} />);

  test("the header buttons announce words, not glyphs", () => {
    sidebar({ onToggleCollapse: () => {} });
    // Header only: the empty-state "+ Add session" button lower in the tree
    // already reads as words and is not part of this finding.
    // Previously "+" and "<<": for a <button> the content beats the title, so
    // the title text those carried never reached assistive tech.
    expect(namesOf("button", document.querySelector(".phn-sidebar-header")))
      .toEqual(["Add session", "Collapse sidebar"]);
  });

  test("the collapse toggle reports its state and flips its name", () => {
    const { rerender } = sidebar({ onToggleCollapse: () => {} });
    const btn = () => document.querySelector(".phn-sidebar-collapse-btn");
    expect(btn().getAttribute("aria-expanded")).toBe("true");
    expect(accessibleName(btn(), document.body)).toBe("Collapse sidebar");

    rerender(<ProjectSidebar projects={[]} collapsed onAddProject={() => {}} onToggleCollapse={() => {}} />);
    expect(btn().getAttribute("aria-expanded")).toBe("false");
    expect(accessibleName(btn(), document.body)).toBe("Expand sidebar");
  });

  test("the docked one-way collapse control is named, and does not claim to be a disclosure", () => {
    // This is the half of A11Y-02 that ProjectSidebar owns. The matching
    // EXPAND control is the rail TerminalsTab renders in the sidebar's place,
    // chrome/CollapsedRail.jsx, keyboard-reachable and covered by its own
    // test. This test only pins the naming of the collapse side.
    sidebar({ docked: true, onCollapse: () => {} });
    const btn = document.querySelector(".moba-tree-collapse");
    expect(accessibleName(btn, document.body)).toBe("Collapse sessions panel");
    // And it must NOT carry aria-expanded. Pressing it unmounts the sidebar
    // (TerminalsTab swaps in .moba-railcol), so the attribute could only ever
    // be read as "true" and there is no aria-controls naming what it toggles.
    // A disclosure structurally incapable of reporting "collapsed" promises a
    // two-state control that can be reopened from here, which is the one-way
    // door A11Y-02 is about. The genuine toggle tested above flips both ways.
    expect(btn.getAttribute("aria-expanded")).toBeNull();
  });
});
