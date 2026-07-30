import { useState, useRef, useEffect, useCallback, useMemo } from "react";

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface FileGroup {
  file: string;
  matches: SearchResult[];
}

interface SearchPanelProps {
  fsBasePath: string;
  onOpenFile: (fsPath: string, line?: number, query?: string) => void;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="search-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function SearchPanel({ fsBasePath, onOpenFile }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const queryRef = useRef(query);
  queryRef.current = query;

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async (q?: string) => {
    const term = (q ?? queryRef.current).trim();
    if (!term || term.length < MIN_QUERY) {
      setResults([]);
      setError("");
      setCollapsed(new Set());
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}&root=${encodeURIComponent(fsBasePath)}`);
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.results || []);
      setCollapsed(new Set());
    } catch (err: any) {
      setError(err.message || "Search failed");
      setResults([]);
      setCollapsed(new Set());
    } finally {
      setLoading(false);
    }
  }, [fsBasePath]);

  // Group results by file, preserving insertion order
  const fileGroups = useMemo<FileGroup[]>(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const list = map.get(r.file);
      if (list) {
        list.push(r);
      } else {
        map.set(r.file, [r]);
      }
    }
    return [...map.entries()].map(([file, matches]) => ({ file, matches }));
  }, [results]);

  // Debounced search on typing
  const handleChange = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), DEBOUNCE_MS);
  }, [doSearch]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      clearTimeout(debounceRef.current);
      doSearch();
    }
  }, [doSearch]);

  const toggleCollapse = useCallback((file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  }, []);

  const noResults = !loading && !error && results.length === 0 && query.trim().length >= MIN_QUERY;
  const tooShort = !loading && !error && results.length === 0 && query.trim().length < MIN_QUERY;

  return (
    <div className="search-panel">
      <div className="search-bar">
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="Search across workspace..."
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="search-btn" onClick={() => { clearTimeout(debounceRef.current); doSearch(); }} disabled={loading || query.trim().length < MIN_QUERY}>
          <i className={`codicon ${loading ? "codicon-loading codicon-modifier-spin" : "codicon-search"}`} />
        </button>
      </div>

      <div className="search-results">
        {error && <div className="search-error">{error}</div>}
        {noResults && <div className="search-empty">No results for "{query}"</div>}
        {tooShort && <div className="search-hint">Type at least {MIN_QUERY} characters to search across the workspace</div>}
        {fileGroups.map((group) => {
          const isOpen = !collapsed.has(group.file);
          return (
            <div key={group.file} className="search-file-node">
              <div className="search-file-header" onClick={() => onOpenFile(group.file)}>
                <span
                  className={`search-file-chevron${isOpen ? " open" : ""}`}
                  onClick={(e) => { e.stopPropagation(); toggleCollapse(group.file); }}
                  title={isOpen ? "Collapse" : "Expand"}
                >&#9654;</span>
                <span className="search-file-name" title={group.file}>
                  {group.file}
                </span>
                <span className="search-file-count">{group.matches.length}</span>
              </div>
              {isOpen && group.matches.map((m, i) => (
                <div
                  key={`${m.file}:${m.line}:${i}`}
                  className="search-match-item"
                  onClick={() => onOpenFile(m.file, m.line, query)}
                >
                  <span className="search-match-lnum">{m.line}</span>
                  <span className="search-match-text">{highlightMatch(m.text.trim(), query)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
