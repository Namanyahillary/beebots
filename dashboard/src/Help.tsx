// Tiny (?) explainer: button + modal reusing the .modal-back/.modal/.modal-x conventions. Read-only.
import { useEffect, useState, type ReactNode } from "react";

export function Help({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);

  return (
    <>
      <button type="button" className="help-btn" onClick={() => setOpen(true)} aria-label={`About ${title}`} title={`About ${title}`}>
        ?
      </button>
      {open && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
            <button className="modal-x" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
            <h2 id="help-title">{title}</h2>
            <div className="help-body">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
