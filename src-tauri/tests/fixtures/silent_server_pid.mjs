// (C) The real server behind a launcher, for the process-tree test in
// tests/mcp_mock.rs: it writes its pid to the file named by argv[2] and never
// answers initialize. The test starts it through a shell (`cmd /c` on
// Windows, `sh -c` elsewhere), so the shell is the app's direct child and this
// is the grandchild, the shape of an MCP server started by `cmd /c` or `uvx`.
// (A node launcher did not show the bug on Windows in testing: libuv appears
// to put the children it spawns in a kill-on-close job of its own.)
import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], String(process.pid));
// Stays up on its own, as a real server would after its stdin closed: only a
// kill of the whole process tree ends it.
setInterval(() => {}, 1 << 30);
