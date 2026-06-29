import { useState, useRef, useEffect, useCallback } from "react";

interface Props {
  open: boolean;
  title: string;
  defaultValue?: string;
  extraLabel?: string;
  extraValue?: string;
  placeholder?: string;
  okLabel?: string;
  onOk: (value: string, extra?: string) => void;
  onCancel: () => void;
}

export default function NameDialog({
  open, title, defaultValue = "", extraLabel, extraValue = "", placeholder,
  okLabel = "OK",
  onOk, onCancel,
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const [edir, setEdir] = useState(extraValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setEdir(extraValue);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, defaultValue, extraValue]);

  const handleOk = useCallback(() => {
    if (value.trim()) onOk(value.trim(), extraLabel ? (edir.trim() || undefined) : undefined);
  }, [value, edir, extraLabel, onOk]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); handleOk(); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  }, [handleOk, onCancel]);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          {extraLabel && (
            <div className="dialog-extra">
              <label className="dialog-label">{extraLabel}</label>
              <input
                className="dialog-input"
                value={edir}
                onChange={(e) => setEdir(e.target.value)}
                placeholder="directory path"
                style={{ width: "40%", fontSize: "11px" }}
              />
            </div>
          )}
          <input
            ref={inputRef}
            className="dialog-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            style={{ flex: 1 }}
          />
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn cancel" onClick={onCancel}>Cancel</button>
          <button className="dialog-btn ok" onClick={handleOk} disabled={!value.trim()}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
