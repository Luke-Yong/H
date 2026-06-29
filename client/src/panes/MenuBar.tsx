import { useState, useRef, useEffect } from "react";

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

  return (
    <div className="menu-bar">
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
  );
}
