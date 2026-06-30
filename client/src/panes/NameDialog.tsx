import { useState, useRef, useEffect, useCallback } from "react";

interface Props {
  open: boolean;
  title: string;
  defaultValue?: string;
  extraValue?: string;
  placeholder?: string;
  okLabel?: string;
  type?: "file" | "folder";
  existingNames?: string[];
  onOk: (value: string, extra?: string) => void;
  onCancel: () => void;
}

export default function NameDialog({
  open, title, defaultValue = "", extraValue = "", placeholder,
  okLabel = "OK", type, existingNames,
  onOk, onCancel,
}: Props) {
  const [name, setName] = useState("");
  const [ext, setExt] = useState("");
  const [value, setValue] = useState(defaultValue); // for rename (no type)
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const extRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setExt("");
      setValue(defaultValue);
      setError("");
      // Focus the appropriate first input
      setTimeout(() => {
        if (type) {
          nameRef.current?.focus();
        } else {
          // inputRef is handled by separate logic below via ref trick
        }
      }, 50);
    }
  }, [open, defaultValue, type]);

  const checkDuplicate = useCallback((fullName: string): boolean => {
    if (!existingNames || existingNames.length === 0) return false;
    return existingNames.some((n) => n.toLowerCase() === fullName.toLowerCase());
  }, [existingNames]);

  const canOk = (() => {
    if (type) {
      const n = name.trim();
      if (!n) return false;
      if (type === "file") {
        if (!ext.trim()) return false;
        const fullName = n + "." + ext.trim();
        if (checkDuplicate(fullName)) return false;
        return true;
      }
      // folder
      if (checkDuplicate(n)) return false;
      return true;
    }
    // rename: just need non-empty value
    return !!value.trim();
  })();

  const handleOk = useCallback(() => {
    if (type === "file") {
      const n = name.trim();
      const e = ext.trim();
      const fullName = n + "." + e;
      if (checkDuplicate(fullName)) {
        setError(`"${fullName}" already exists`);
        return;
      }
      onOk(fullName, extraValue || undefined);
    } else if (type === "folder") {
      const n = name.trim();
      if (checkDuplicate(n)) {
        setError(`"${n}" already exists`);
        return;
      }
      onOk(n, extraValue || undefined);
    } else {
      if (value.trim()) onOk(value.trim());
    }
  }, [type, name, ext, value, extraValue, checkDuplicate, onOk]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); handleOk(); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  }, [handleOk, onCancel]);

  // Clear error when user types
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    setError("");
  }, []);
  const handleExtChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setExt(e.target.value);
    setError("");
  }, []);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body" style={{ flexDirection: "column", gap: 8 }}>
          {/* Path display above inputs */}
          {type && extraValue && (
            <div className="dialog-extra">
              <span className="dialog-label">Path:</span>
              <span className="dialog-path">{extraValue}</span>
            </div>
          )}
          {type === "file" ? (
            <div className="dialog-file-inputs">
              <input
                ref={nameRef}
                className="dialog-input dialog-name-input"
                value={name}
                onChange={handleNameChange}
                placeholder="filename"
              />
              <span className="dialog-ext-dot">.</span>
              <input
                ref={extRef}
                className="dialog-input dialog-ext-input"
                value={ext}
                onChange={handleExtChange}
                placeholder="ext"
              />
            </div>
          ) : type === "folder" ? (
            <input
              ref={nameRef}
              className="dialog-input"
              value={name}
              onChange={handleNameChange}
              placeholder="folder name"
            />
          ) : (
            <input
              className="dialog-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              autoFocus
            />
          )}
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn cancel" onClick={onCancel}>Cancel</button>
          <button className="dialog-btn ok" onClick={handleOk} disabled={!canOk}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
