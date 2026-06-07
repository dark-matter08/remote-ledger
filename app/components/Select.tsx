import { useEffect, useRef, useState } from "react";

export interface Opt {
  value: string;
  label: string;
  disabled?: boolean;
}

// Custom, Heritage-Press-styled select. Carries its value in a hidden input so it
// works inside a normal <Form> exactly like a native <select name=...>.
export function Select({
  name,
  defaultValue,
  options,
  placeholder = "Select…",
}: {
  name: string;
  defaultValue?: string;
  options: Opt[];
  placeholder?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const cur = options.find((o) => o.value === value);
  return (
    <div className="fsel" data-open={open ? "" : undefined} ref={ref}>
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        className="fsel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="fsel-val">{cur ? cur.label : placeholder}</span>
        <span className="fsel-caret">▾</span>
      </button>
      {open && (
        <ul className="fsel-menu" role="listbox">
          {options.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={o.disabled ? "disabled" : ""}
              onClick={() => {
                if (o.disabled) return;
                setValue(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
              {o.value === value ? <span className="fsel-check">✓</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
