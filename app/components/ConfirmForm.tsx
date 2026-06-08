import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Form } from "react-router";

// A react-router <Form> that pops a custom Heritage Press confirm dialog before it
// submits — replaces the native window.confirm(). Drop-in: same props as <Form>,
// plus `confirm` (message), optional `confirmLabel`, `title`, and `danger`.
export function ConfirmForm({
  confirm,
  confirmLabel = "Confirm",
  title = "Are you sure?",
  danger = true,
  children,
  ...formProps
}: {
  confirm: string;
  confirmLabel?: string;
  title?: string;
  danger?: boolean;
  children: ReactNode;
} & React.ComponentProps<typeof Form>) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const okRef = useRef(false);

  return (
    <>
      <Form
        {...formProps}
        ref={formRef}
        onSubmit={(e) => {
          if (okRef.current) { okRef.current = false; return; } // confirmed → let RR submit
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </Form>

      {open && typeof document !== "undefined" && createPortal(
        <div className="modal-scrim" onClick={() => setOpen(false)}>
          <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{title}</h3>
            <p className="modal-body">{confirm}</p>
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={() => setOpen(false)} autoFocus>Cancel</button>
              <button
                type="button"
                className={danger ? "btn danger" : "btn"}
                onClick={() => { okRef.current = true; setOpen(false); formRef.current?.requestSubmit(); }}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
