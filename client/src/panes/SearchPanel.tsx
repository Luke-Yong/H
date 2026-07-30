import { useState, useRef, useEffect, useCallback } from "react";

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface SearchPanelProps {
  fsBasePath: string;
  onOpenFile: (fsPath: string, line?: number) => void;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export default function SearchPanel({ fsBasePath, onOpenFile }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
    } catch (err: any) {
      setError(err.message || "Search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [fsBasePath]);

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
        {!loading && !error && results.length === 0 && query.trim().length >= MIN_QUERY && (
          <div className="search-empty">No results for "{query}"</div>
        )}
        {!loading && !error && results.length === 0 && query.trim().length < MIN_QUERY && (
          <div className="search-hint">Type at least {MIN_QUERY} characters to search across the workspace</div>
        )}
        {results.map((r, i) => (
          <div
            key={`${r.file}:${r.line}:${i}`}
            className="search-result-item"
            onClick={() => onOpenFile(r.file, r.line)}
          >
            <span className="search-result-file" title={r.file}>
              {r.file.split("/").pop()}
              <span className="search-result-path">{r.file}</span>
            </span>
            <span className="search-result-line">
              <span className="search-result-lnum">{r.line}</span>
              <span className="search-result-text">{r.text.trim()}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
