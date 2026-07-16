import { useState, useRef, useEffect, useCallback } from "react";

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

interface MenuDef {
  label: string;
  items: (MenuItem | "---")[];
}

interface Props {
  menus: MenuDef[];
}

function Dropdown({ label, items, isOpen, onToggle, onClose }: {
  label: string;
  items: (MenuItem | "---")[];
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);

  return (
    <div className="menu-dropdown" ref={ref}>
      <button
        className={`menu-trigger${isOpen ? " open" : ""}`}
        onClick={onToggle}
        onMouseEnter={() => isOpen && onToggle()}
      >
        {label}
      </button>
      {isOpen && (
        <div className="menu-panel">
          {items.map((item, i) =>
            item === "---" ? (
              <div key={i} className="menu-separator" />
            ) : (
              <button
                key={i}
                className="menu-item"
                disabled={item.disabled}
                onClick={() => {
                  item.action();
                  onClose();
                }}
              >
                <span>{item.label}</span>
                {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function MenuBar({ menus }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [isMax, setIsMax] = useState(false);

  const syncMax = useCallback(() => {
    window.harnessDesktop?.isMaximized?.().then(setIsMax).catch(() => {});
  }, []);

  useEffect(() => {
    syncMax();
    const onResize = () => syncMax();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [syncMax]);

  const isDesktop = !!window.harnessDesktop?.isDesktop;

  return (
    <div className="menu-bar" onDoubleClick={() => { window.harnessDesktop?.maximize?.(); syncMax(); }}>
      <div className="menu-bar-app-name">
        <img src="/icon.svg" className="menu-bar-app-icon" alt="" />
        Harness
      </div>
      <div className="menu-bar-menus">
        {menus.map((menu, i) => (
          <Dropdown
            key={i}
            label={menu.label}
            items={menu.items}
            isOpen={openIndex === i}
            onToggle={() => setOpenIndex(openIndex === i ? null : i)}
            onClose={() => setOpenIndex(null)}
          />
        ))}
      </div>
      {isDesktop && (
        <div className="menu-bar-window-controls">
          <button className="win-ctrl-btn win-ctrl-min" onClick={() => window.harnessDesktop?.minimize?.()} title="Minimize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1" fill="currentColor" /></svg>
          </button>
          <button className="win-ctrl-btn win-ctrl-max" onClick={() => { window.harnessDesktop?.maximize?.(); syncMax(); }} title={isMax ? "Restore" : "Maximize"}>
            {isMax ? (
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="0" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" /><rect x="0" y="3" width="7" height="7" fill="#323233" stroke="currentColor" strokeWidth="1" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            )}
          </button>
          <button className="win-ctrl-btn win-ctrl-close" onClick={() => window.harnessDesktop?.close?.()} title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" /><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
