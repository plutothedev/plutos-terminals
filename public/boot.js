// Pre-paint theme background (external file — see boot.css for why this must
// never be inline). headerSkins.js writes the RESOLVED page background to one
// per-window key every time a theme applies; this just reads it.
try {
  var w = new URLSearchParams(location.search).get("w");
  var bg = localStorage.getItem("plutos-terminals:boot-bg" + (w ? ":" + w : ""));
  if (bg && /^#[0-9a-fA-F]{3,8}$/.test(bg)) {
    document.documentElement.style.background = bg;
  }
} catch (e) { /* first boot / blocked storage: keep the dark default */ }
