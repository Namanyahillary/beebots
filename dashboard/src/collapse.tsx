// Collapsible panels with memory: collapsed state persists in localStorage so the
// layout the owner chose survives reloads. Keys are stable panel ids.
import { useCallback, useState, type ReactElement } from "react";

const KEY = "wolfbots.ui.collapsed";

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** [collapsed, toggleButton] for a panel id. The button carries no layout assumptions. */
export function useCollapsed(id: string): [boolean, ReactElement] {
  const [map, setMap] = useState<Record<string, boolean>>(load);
  const collapsed = map[id] === true;
  const toggle = useCallback(() => {
    setMap((prev) => {
      const next = { ...prev, [id]: !(prev[id] === true) };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* private mode: layout just won't persist */
      }
      return next;
    });
  }, [id]);
  const btn = (
    <button type="button" className="collapse-btn" onClick={toggle} aria-label={collapsed ? "Expand panel" : "Collapse panel"} title={collapsed ? "Expand" : "Collapse"}>
      {collapsed ? "▸" : "▾"}
    </button>
  );
  return [collapsed, btn];
}
