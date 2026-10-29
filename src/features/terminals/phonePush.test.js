// (C)
// The phone page's push setup (src-tauri/companion-web/app.js), run against
// stand-ins for the browser's push APIs. The page is a plain script that
// boots a socket on load, so the push block is cut out of its source and run
// on its own: every way registration can fail has to say so on the 🔕 button
// instead of being swallowed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const app = readFileSync(path.join(process.cwd(), "src-tauri/companion-web/app.js"), "utf8").replace(/\r\n/g, "\n");
const block = app.slice(app.indexOf("function urlB64ToUint8Array(b64) {"), app.indexOf("let backoff = 1000"));
const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

function page({
  protocol = "https:",
  ua = "Mozilla/5.0 (Linux; Android 14) Chrome/130",
  sw = true,
  permission = "granted",
  grantOnAsk = null,
  register = null,
  existing = null,
  subscribe = async () => ({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/x" }) }),
  rpcs = {},
  touch = 0,
} = {}) {
  const calls = [];
  const els = { pushbtn: { classList: classes(["hidden"]), title: "" }, pushnote: { classList: classes(["hidden"]), textContent: "" } };
  const shown = [];
  const Notification = {
    permission,
    async requestPermission() {
      calls.push("ask");
      if (grantOnAsk) Notification.permission = grantOnAsk;
      return Notification.permission;
    },
  };
  const reg = {
    pushManager: {
      getSubscription: async () => existing,
      subscribe: async (opts) => { calls.push("subscribe"); return subscribe(opts); },
    },
  };
  const navigator = { userAgent: ua, maxTouchPoints: touch, ...(sw ? { serviceWorker: { register: register || (async () => reg) } } : {}) };
  const window = { Notification, ...(sw ? { PushManager: function () {} } : {}) };
  const rpc = async (cmd, args) => {
    calls.push(cmd);
    const r = rpcs[cmd];
    if (r instanceof Error) throw r.message;
    if (typeof r === "function") return r(args);
    return cmd === "vapid_public_key" && !(cmd in rpcs) ? "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" : r;
  };
  const ws = { readyState: 1 };
  const fits = [];
  const run = new Function(
    "location", "navigator", "window", "Notification", "rpc", "$", "status", "ws", "socketReady", "atob", "fit", "sendResize",
    block + "\nreturn { registerPush, resetPush, tap: () => $(\"pushbtn\").onclick() };",
  );
  const api = run({ protocol }, navigator, window, Notification, rpc, (id) => els[id], (t, c) => shown.push([t, c]), ws, true, atob,
    { fit: () => fits.push("fit") }, () => fits.push("resize"));
  return { ...api, calls, button: els.pushbtn, note: els.pushnote, shown, fits, reg, Notification };
}

function classes(init) {
  const set = new Set(init);
  return {
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
  };
}

describe("the phone page's push setup", () => {
  it("registers, hides the button and says push is on", async () => {
    const p = page();
    expect(await p.registerPush(false)).toBe(null);
    expect(p.calls).toEqual(["vapid_public_key", "subscribe", "push_subscribe"]);
    expect(p.button.classList.contains("hidden")).toBe(true);
    expect(p.shown).toEqual([["push on", "ok"]]);
  });

  it("shows the desktop's refusal on the button instead of swallowing it", async () => {
    const p = page({ rpcs: { push_subscribe: new Error("subscription keys are missing or malformed") } });
    const problem = await p.registerPush(false);
    expect(problem).toBe("The desktop refused this phone's push registration: subscription keys are missing or malformed");
    expect(p.button.classList.contains("hidden")).toBe(false);
    expect(p.button.title).toBe(problem);
    // At connect the page stays as it was; a tap shows the reason on its own line.
    expect(p.shown).toEqual([]);
    expect(p.note.classList.contains("hidden")).toBe(true);
    await p.registerPush(true);
    expect(p.note.classList.contains("hidden")).toBe(false);
    expect(p.note.textContent).toBe(problem);
    expect(p.shown).toEqual([]);
  });

  it("says why for each other way it can fail", async () => {
    const cases = [
      [{ protocol: "http:" }, "Push needs the https address (Tailscale) of the desktop."],
      [{ sw: false, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, "On iPhone, add this page to the Home Screen and open it from there to get notifications."],
      [{ sw: false, ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", touch: 5 }, "On iPhone, add this page to the Home Screen and open it from there to get notifications."],
      [{ sw: false, ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15" }, "This browser cannot receive push notifications."],
      [{ sw: false }, "This browser cannot receive push notifications."],
      [{ register: async () => { throw new Error("SecurityError"); } }, "The notification worker did not start: SecurityError"],
      [{ permission: "denied" }, "Notifications are blocked for this page in the browser's settings."],
      [{ permission: "default" }, "Tap to turn on notifications."],
      [{ rpcs: { vapid_public_key: null } }, "The desktop has no push key."],
      [{ rpcs: { vapid_public_key: new Error("keychain locked") } }, "The desktop has no push key: keychain locked"],
      [{ subscribe: async () => { throw new Error("AbortError: push service not available"); } }, "The browser refused the push subscription: AbortError: push service not available"],
    ];
    for (const [opts, want] of cases) {
      const p = page(opts);
      expect(await p.registerPush(false), JSON.stringify(opts)).toBe(want);
      // Over plain http the phone cannot fix it, so the button stays away.
      expect(p.button.classList.contains("hidden")).toBe(opts.protocol === "http:");
      expect(p.button.title).toBe(want);
      await p.registerPush(true);
      expect(p.note.textContent).toBe(want);
    }
  });

  it("asks for permission inside the tap itself, then registers", async () => {
    const p = page({ permission: "default" });
    const atConnect = await p.registerPush(false);
    expect(atConnect).toBe("Tap to turn on notifications.");
    p.calls.splice(0);
    p.Notification.requestPermission = async () => { p.calls.push("ask"); p.Notification.permission = "granted"; return "granted"; };
    p.tap();
    // Synchronously, before anything is awaited: iOS drops a later request.
    expect(p.calls).toEqual(["ask"]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.calls).toEqual(["ask", "vapid_public_key", "subscribe", "push_subscribe"]);
    expect(p.button.classList.contains("hidden")).toBe(true);
    expect(p.note.classList.contains("hidden")).toBe(true);
  });

  it("does not let a try the last socket took down hold off the next socket's", async () => {
    let calls = 0;
    const p = page({ rpcs: { vapid_public_key: () => (++calls === 1 ? new Promise(() => {}) : KEY) } });
    const dead = p.registerPush(false);
    expect(p.registerPush(false)).toBe(dead);
    p.resetPush();
    expect(await p.registerPush(false)).toBe(null);
    // onReady resets before it awaits anything.
    const onReady = app.slice(app.indexOf("async function onReady() {"), app.indexOf("registerPush(false);"));
    expect(onReady.indexOf("resetPush();")).toBeGreaterThan(-1);
    expect(onReady.indexOf("await")).toBeGreaterThan(onReady.indexOf("resetPush();"));
  });

  it("lets a late try from the last socket touch neither the lock nor the page", async () => {
    const slowWorker = deferred();
    const slowKey = deferred();
    let workers = 0;
    let keys = 0;
    const p = page({
      register: () => (++workers === 1 ? slowWorker.promise : Promise.resolve(p.reg)),
      rpcs: { vapid_public_key: () => (++keys === 1 ? slowKey.promise : KEY) },
    });
    const old = p.registerPush(false);
    p.resetPush();
    const fresh = p.registerPush(false);
    await settle();
    slowWorker.resolve(p.reg);
    expect(await old).toBe(null);
    expect(p.registerPush(false)).toBe(fresh);
    expect(p.shown).toEqual([]);
    slowKey.resolve(KEY);
    expect(await fresh).toBe(null);
    expect(p.shown).toEqual([["push on", "ok"]]);
  });

  it("answers a tap made during the connect try with a try of its own", async () => {
    const slow = deferred();
    let keys = 0;
    const p = page({ rpcs: { vapid_public_key: () => (++keys === 1 ? slow.promise : Promise.reject("keychain locked")) } });
    const atConnect = p.registerPush(false);
    p.tap();
    slow.reject("keychain locked");
    expect(await atConnect).toBe("The desktop has no push key: keychain locked");
    await settle();
    expect(keys).toBe(2);
    expect(p.note.classList.contains("hidden")).toBe(false);
    expect(p.note.textContent).toBe("The desktop has no push key: keychain locked");
  });

  it("lets taps made during a try share one retry, and a dead socket keep none of them", async () => {
    const slow = deferred();
    let workers = 0;
    const p = page({ register: () => (++workers === 1 ? slow.promise : Promise.resolve(p.reg)) });
    const atConnect = p.registerPush(false);
    const taps = [1, 2, 3, 4, 5].map(() => p.registerPush(true));
    expect(new Set(taps).size).toBe(1);
    slow.resolve(p.reg);
    await atConnect;
    expect(await taps[0]).toBe(null);
    expect(workers).toBe(2);
    // Taps queued on a try the last socket took down are dropped with it:
    // a tap during the next socket's try gets a retry of its own.
    let tries = 0;
    const stuck = page({ register: () => (++tries === 1 ? new Promise(() => {}) : Promise.resolve(stuck.reg)) });
    stuck.registerPush(false);
    const dead = stuck.registerPush(true);
    stuck.resetPush();
    stuck.registerPush(false);
    const tap = stuck.registerPush(true);
    expect(tap).not.toBe(dead);
    expect(await tap).toBe(null);
  });

  it("fits the terminal again only when the note comes or goes", async () => {
    const p = page({ rpcs: { push_subscribe: new Error("nope") } });
    await p.registerPush(false);
    expect(p.fits).toEqual([]);
    await p.registerPush(true);
    expect(p.fits).toEqual(["fit", "resize"]);
    await p.registerPush(true);
    expect(p.fits).toEqual(["fit", "resize"]);
  });

  it("takes a tap only on a socket that passed auth", () => {
    expect(app).toContain('$("pushbtn").onclick = () => {\n  if (!socketReady || !ws || ws.readyState !== 1) return;');
  });

  it("reuses an existing subscription and does not stack tries", async () => {
    const p = page({ existing: { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/y" }) } });
    const [a, b] = [p.registerPush(false), p.registerPush(false)];
    expect(a).toBe(b);
    expect(await a).toBe(null);
    expect(p.calls).toEqual(["push_subscribe"]);
  });
});
