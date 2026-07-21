// (C)
// Settings → Agent: global rules text injected into every agent run (above
// project rule files) + the project-context toggle. Plain userSt fields —
// not secrets, so they ride cloud sync. Functional saveUser only. This text
// is SENT TO THE CONFIGURED LLM PROVIDER on every agent run (the hint says
// so); the shared secretScan masks recognizable keys, but don't put secrets here.
import { Textarea } from "../../components/ui.jsx";

export default function AgentSection({ userSt, saveUser }) {
  const rules = userSt?.agentRules || "";
  const enabled = userSt?.agentContextEnabled !== false;

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
        Inject project context (AGENTS.md / CLAUDE.md, git facts) into agent runs
      </label>
      <div className="phn-ui-hint" style={{ marginBottom: 6 }}>
        Rules are included in every agent run, above project rule files, and are sent to your configured model provider. Style and expectations only; rules cannot authorize destructive actions or enable auto-run. Do not paste secrets here.
      </div>
      <Textarea
        value={rules}
        onChange={(e) => {
          const v = e.target.value;
          saveUser((prev) => ({ ...prev, agentRules: v }));
        }}
        rows={8}
        placeholder={"e.g. Prefer PowerShell syntax. Never touch files outside the repo. Explain before multi-step operations."}
        style={{ fontFamily: "inherit", fontSize: 13 }}
      />
    </div>
  );
}
