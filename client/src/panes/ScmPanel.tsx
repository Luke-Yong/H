import { useState, useEffect, useCallback } from "react";

interface GitChange {
  path: string;
  status: string;
}

interface GitCommit {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  refs?: string;
}

interface GitStatus {
  ok: boolean;
  error?: string;
  branch?: string;
  staged: GitChange[];
  unstaged: GitChange[];
}

interface GitLog {
  ok: boolean;
  error?: string;
  commits: GitCommit[];
  remoteUrl: string;
}

const STATUS_LABEL: Record<string, string> = {
  "M": "Modified", "A": "Added", "D": "Deleted",
  "R": "Renamed", "C": "Copied", "U": "Untracked",
  "AM": "Added/Modified", "MM": "Modified/Modified",
  "??": "Untracked",
};

function statusClass(s: string): string {
  if (s === "M" || s.includes("M")) return "scm-status-modified";
  if (s === "A" || s.includes("A")) return "scm-status-added";
  if (s === "D" || s.includes("D")) return "scm-status-deleted";
  if (s === "U" || s === "??" || s === "?") return "scm-status-untracked";
  return "scm-status-modified";
}

// Normalize git status: "?" / "??" → "U" for display.
function displayStatus(s: string): string {
  if (s === "?" || s === "??") return "U";
  return s;
}

export default function ScmPanel({ fsBasePath, newFilePaths }: { fsBasePath: string; newFilePaths?: Set<string> }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLog | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [stagedOpen, setStagedOpen] = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(true);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const url = fsBasePath ? `/api/git/status?path=${encodeURIComponent(fsBasePath)}` : "/api/git/status";
      const res = await fetch(url);
      const data: GitStatus = await res.json();
      setStatus(data);
    } catch { /* */ }
    finally { setStatusLoading(false); }
  }, [fsBasePath]);

  const fetchLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const url = fsBasePath ? `/api/git/log?limit=30&path=${encodeURIComponent(fsBasePath)}` : "/api/git/log?limit=30";
      const res = await fetch(url);
      const data: GitLog = await res.json();
      setLog(data);
    } catch { /* */ }
    finally { setLogLoading(false); }
  }, [fsBasePath]);

  useEffect(() => {
    if (fsBasePath) {
      fetchStatus();
      fetchLog();
    } else {
      setStatus(null);
      setLog(null);
    }
  }, [fetchStatus, fetchLog, fsBasePath]);

  const gitAction = async (action: string) => {
    setActionBusy(action);
    try {
      const url = `/api/git/${action}${fsBasePath ? `?path=${encodeURIComponent(fsBasePath)}` : ""}`;
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        // Not a repo — silently ignore
      }
      // Refresh status after action
      await fetchStatus();
      await fetchLog();
    } catch { /* */ }
    finally { setActionBusy(""); }
  };

  const isRepo = status?.ok;
  const branch = status?.branch || "main";
  const remoteUrl = log?.remoteUrl || "";
  const githubUrl = remoteUrl.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");

  return (
    <div className="scm-panel">
      {/* Source Control header */}
      <div className="scm-header">
        <span className="scm-header-title">SOURCE CONTROL</span>
        {isRepo && <span className="scm-branch">⎇ {branch}</span>}
      </div>

      {!fsBasePath && (
        <div className="scm-empty" style={{ padding: "16px 12px" }}>
          Open a folder to view source control.
        </div>
      )}

      {fsBasePath && (<>
      {/* Graph toolbar */}
      <div className="scm-graph-toolbar">
        <span className="scm-graph-label">GRAPH</span>
        <div className="scm-graph-actions">
          <button
            className="scm-graph-btn"
            onClick={() => gitAction("fetch")}
            disabled={actionBusy !== ""}
            title="Fetch from all remotes"
          >
            {actionBusy === "fetch" ? "..." : "↓↑"} Fetch
          </button>
          <button
            className="scm-graph-btn"
            onClick={() => gitAction("pull")}
            disabled={actionBusy !== ""}
            title="Pull"
          >
            {actionBusy === "pull" ? "..." : "↓"} Pull
          </button>
          <button
            className="scm-graph-btn"
            onClick={() => gitAction("push")}
            disabled={actionBusy !== ""}
            title="Push"
          >
            {actionBusy === "push" ? "..." : "↑"} Push
          </button>
          <button className="scm-graph-btn" title="Refresh" onClick={() => { fetchStatus(); fetchLog(); }} disabled={statusLoading}>
            {statusLoading ? "..." : "↻"}
          </button>
        </div>
      </div>

      {/* Not a repo */}
      {!isRepo && !statusLoading && (
        <div className="scm-empty" style={{ padding: "16px 12px" }}>
          {status?.error || "Open a git repository to see changes."}
        </div>
      )}

      {/* Loading */}
      {statusLoading && !status && (
        <div className="scm-empty" style={{ padding: "16px 12px" }}>Loading repository status...</div>
      )}

      {/* Staged Changes */}
      {isRepo && (
        <div className="scm-section">
          <div className="scm-section-header" onClick={() => setStagedOpen((v) => !v)}>
            <span className="scm-section-toggle">{stagedOpen ? "▾" : "▸"}</span>
            <span className="scm-section-title">Staged Changes</span>
            <span className="scm-section-count">{status!.staged.length}</span>
          </div>
          {stagedOpen && (
            <div className="scm-section-body">
              {status!.staged.length === 0 && (
                <div className="scm-empty">No staged changes. Stage changes with `git add`.</div>
              )}
              {status!.staged.map((c, i) => (
                <div key={i} className="scm-item">
                  <span className={`scm-status ${statusClass(c.status)}`}>{displayStatus(c.status)}</span>
                  <span className="scm-path">{c.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Unstaged Changes */}
      {isRepo && (
        <div className="scm-section">
          <div className="scm-section-header" onClick={() => setUnstagedOpen((v) => !v)}>
            <span className="scm-section-toggle">{unstagedOpen ? "▾" : "▸"}</span>
            <span className="scm-section-title">Changes</span>
            <span className="scm-section-count">{status!.unstaged.length}</span>
          </div>
          {unstagedOpen && (
            <div className="scm-section-body">
              {status!.unstaged.length === 0 && (
                <div className="scm-empty">No unstaged changes found.</div>
              )}
              {status!.unstaged.map((c, i) => (
                <div key={i} className="scm-item">
                  <span className={`scm-status ${statusClass(c.status)}`}>{displayStatus(c.status)}</span>
                  <span className="scm-path">{c.path}</span>
                  <div className="scm-item-actions">
                    {/* File action stubs */}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Agent-created files (not yet in git) */}
      {newFilePaths && newFilePaths.size > 0 && (
        <div className="scm-section">
          <div className="scm-section-header">
            <span className="scm-section-toggle">▾</span>
            <span className="scm-section-title">New Files</span>
            <span className="scm-section-count">{newFilePaths.size}</span>
          </div>
          <div className="scm-section-body">
            {[...newFilePaths].map((p) => (
              <div key={p} className="scm-item">
                <span className="scm-status scm-status-untracked">U</span>
                <span className="scm-path">{p}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Commit History */}
      {(log?.commits?.length ?? 0) > 0 && (
        <div className="scm-section log-section">
          <div className="scm-section-header" onClick={() => setLogOpen((v) => !v)}>
            <span className="scm-section-toggle">{logOpen ? "▾" : "▸"}</span>
            <span className="scm-section-title">Commits</span>
            <span className="scm-section-count">{log!.commits.length}</span>
            {githubUrl && (
              <a
                className="scm-github-link"
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${githubUrl} on GitHub`}
                onClick={(e) => e.stopPropagation()}
              >
                ↗ GitHub
              </a>
            )}
          </div>
          {logOpen && (
            <div className="scm-section-body scm-log-body">
              {log!.commits.map((c) => (
                <div key={c.hash} className="scm-log-item" title={c.hash}>
                  <div className="scm-log-message">{c.message}</div>
                  <div className="scm-log-meta">
                    <span className="scm-log-author">{c.author}</span>
                    <span className="scm-log-date">{c.date}</span>
                    {c.refs && c.refs !== "HEAD" ? (
                      <span className="scm-log-refs">{c.refs.split(", ").map((r) => (
                        <span key={r} className="scm-log-ref">{r}</span>
                      ))}</span>
                    ) : null}
                    <span className="scm-log-hash">{c.hash.substring(0, 7)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </>)}
    </div>
  );
}
