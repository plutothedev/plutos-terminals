// (C)
// Settings → Agent: global rules text injected into every agent run (above
// project rule files) + the project-context toggle. Plain userSt fields —
// not secrets, so they ride cloud sync. Functional saveUser only. This text
// is SENT TO THE CONFIGURED LLM PROVIDER on every agent run (the hint says
// so); the shared secretScan masks recognizable keys, but don't put secrets here.
import { useEffect, useRef, useState } from "react";
import { Textarea } from "../../components/ui.jsx";

export default function AgentSection({ userSt, saveUser }) {
  const enabled = userSt?.agentContextEnabled !== false;

  // Rules is a local draft, committed on blur rather than per keystroke (same
  // shape as ThemesSection's paste buffer: type freely, persist at a
  // boundary). Seeded from props on MOUNT only — if sync applies a remote
  // value while this section stays open, the in-progress draft intentionally
  // keeps winning until the next commit rather than getting clobbered mid-edit.
  const [draft, setDraft] = useState(() => userSt?.agentRules || "");
  const draftRef = useRef(draft);

  const commitRules = () => {
    if (draftRef.current !== (userSt?.agentRules || "")) {
      saveUser((prev) => ({ ...prev, agentRules: draftRef.current }));
    }
  };

  // Flush an unsaved draft on unmount (e.g. Esc closes the modal before blur
  // fires) so an in-progress edit is never silently lost. Compares against
  // the live `prev` (not the possibly-stale `userSt` prop) and returns it
  // unchanged when equal, so a clean close never fires a pointless write.
  useEffect(() => () => {
    const v = draftRef.current;
    saveUser((prev) => ((prev?.agentRules || "") === v ? prev : { ...prev, agentRules: v }));
  }, [saveUser]);

  return (
    <div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const v = e.target.checked;
            saveUser((prev) => ({ ...prev, agentContextEnabled: v }));
          }}
        />
        Inject project context (AGENTS.md / CLAUDE.md, git facts, and your Rules below) into agent runs
      </label>
      <div className="phn-ui-hint" style={{ marginBottom: 6 }}>
        Rules are included in every agent run, above project rule files, and are sent to your configured model provider. Style and expectations only; rules cannot authorize destructive actions or enable auto-run. Do not paste secrets here. Unchecking the toggle above disables all injected context, including these rules.
      </div>
      <Textarea
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          draftRef.current = v;
        }}
        onBlur={commitRules}
        rows={8}
        placeholder={"e.g. Prefer PowerShell syntax. Never touch files outside the repo. Explain before multi-step operations."}
        style={{ fontFamily: "inherit", fontSize: 13 }}
        aria-label="Global agent rules"
      />
    </div>
  );
}
