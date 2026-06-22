import { useState } from "react";

interface Change {
  path: string;
  status: "M" | "A" | "D" | "U";
}

const SAMPLE_CHANGES: Change[] = [];
const SAMPLE_STAGED: Change[] = [];

const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  U: "Untracked",
};

const STATUS_CLASS: Record<string, string> = {
  M: "scm-status-modified",
  A: "scm-status-added",
  D: "scm-status-deleted",
  U: "scm-status-untracked",
};

export default function ScmPanel() {
  const [fetching, setFetching] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);

  const handleGitAction = async (action: string) => {
    const setters: Record<string, (v: boolean) => void> = {
      fetch: setFetching,
      pull: setPulling,
      push: setPushing,
    };
    const setter = setters[action];
    if (setter) setter(true);
    try {
      const res = await fetch(`/api/git/${action}`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) alert(data.error || `Git ${action} failed`);
    } catch {
      // Git operations require a real repo; silently ignore in dev
    } finally {
      if (setter) setter(false);
    }
  };

  return (
    <div className="scm-panel">
      {/* Graph toolbar */}
      <div className="scm-graph-toolbar">
        <span className="scm-graph-label">GRAPH</span>
        <div className="scm-graph-actions">
          <button
            className="scm-graph-btn"
            onClick={() => handleGitAction("fetch")}
            disabled={fetching}
            title="Fetch from all remotes"
          >
            {fetching ? "..." : "↓↑"} Fetch
          </button>
          <button
            className="scm-graph-btn"
            onClick={() => handleGitAction("pull")}
            disabled={pulling}
            title="Pull"
          >
            {pulling ? "..." : "↓"} Pull
          </button>
          <button
            className="scm-graph-btn"
            onClick={() => handleGitAction("push")}
            disabled={pushing}
            title="Push"
          >
            {pushing ? "..." : "↑"} Push
          </button>
          <button className="scm-graph-btn" title="Refresh" onClick={() => handleGitAction("status")}>
            ↻
          </button>
          <button className="scm-graph-btn" title="More actions...">⋯</button>
        </div>
      </div>

      {/* Staged changes */}
      <div className="scm-section">
        <div className="scm-section-header">
          <span className="scm-section-toggle">▾</span>
          <span className="scm-section-title">Staged Changes</span>
          <span className="scm-section-count">{SAMPLE_STAGED.length}</span>
        </div>
        {SAMPLE_STAGED.length === 0 && (
          <div className="scm-empty">
            No staged changes. Stage changes by clicking + next to each file.
          </div>
        )}
        {SAMPLE_STAGED.map((c) => (
          <div key={c.path} className="scm-item">
            <span className={`scm-status ${STATUS_CLASS[c.status]}`}>{c.status}</span>
            <span className="scm-path">{c.path}</span>
          </div>
        ))}
      </div>

      {/* Changes */}
      <div className="scm-section">
        <div className="scm-section-header">
          <span className="scm-section-toggle">▾</span>
          <span className="scm-section-title">Changes</span>
          <span className="scm-section-count">{SAMPLE_CHANGES.length}</span>
        </div>
        {SAMPLE_CHANGES.length === 0 && (
          <div className="scm-empty">
            No changes detected. Open a git repository to see changes here.
          </div>
        )}
        {SAMPLE_CHANGES.map((c) => (
          <div key={c.path} className="scm-item">
            <span className={`scm-status ${STATUS_CLASS[c.status]}`}>{c.status}</span>
            <span className="scm-path">{c.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
