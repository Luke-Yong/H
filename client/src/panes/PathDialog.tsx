import { useState, useRef, useEffect, useCallback } from "react";
import { pickAndEnumerateFolder, pickAndReadFile } from "./browserFs";
import type { FsEntry } from "./FilesPanel";

export interface DialogResult {
  path: string;
  entries?: FsEntry[];
  fileData?: { name: string; content: string; handle: FileSystemFileHandle };
}

interface Props {
  open: boolean;
  title: string;
  defaultValue?: string;
  placeholder?: string;
  browseLabel?: string;
  okLabel?: string;
  browseDir?: boolean;
  onOk: (result: DialogResult) => void;
  onCancel: () => void;
}

export default function PathDialog({
  open, title, defaultValue = "", placeholder,
  browseLabel = "Browse...", okLabel = "OK",
  browseDir = true,
  onOk, onCancel,
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const [browserResult, setBrowserResult] = useState<{
    entries?: FsEntry[];
    name?: string;
    fileData?: DialogResult["fileData"];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setBrowserResult(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, defaultValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); handleOk(); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  }, [value, browserResult]);

  const handleOk = useCallback(() => {
    if (browserResult) {
      if (browserResult.fileData) {
        onOk({ path: browserResult.fileData.name, fileData: browserResult.fileData });
      } else {
        onOk({ path: browserResult.name || value, entries: browserResult.entries });
      }
    } else {
      onOk({ path: value });
    }
  }, [value, browserResult, onOk]);

  const handleBrowse = useCallback(async () => {
    setBrowsing(true);
    try {
      if (browseDir) {
        const result = await pickAndEnumerateFolder();
        if (result) {
          setBrowserResult({ entries: result.entries, name: result.name });
          setValue(result.name);
        }
      } else {
        const result = await pickAndReadFile();
        if (result) {
          setBrowserResult({ fileData: result });
          setValue(result.name);
        }
      }
    } finally {
      setBrowsing(false);
    }
  }, [browseDir]);

  if (!open) return null;

  const isValid = value.trim() || !!browserResult;

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          <input
            ref={inputRef}
            className="dialog-input"
            value={value}
            onChange={(e) => { setValue(e.target.value); setBrowserResult(null); }}
            placeholder={placeholder}
          />
          <button className="dialog-browse-btn" onClick={handleBrowse} disabled={browsing}>
            {browsing ? "..." : browseLabel}
          </button>
        </div>
        {browserResult && !browserResult.fileData && (
          <div className="dialog-hint">
            Selected folder. Contents will be loaded in the file tree.
          </div>
        )}
        <div className="dialog-footer">
          <button className="dialog-btn cancel" onClick={onCancel}>Cancel</button>
          <button className="dialog-btn ok" onClick={handleOk} disabled={!isValid}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
