import { useRef, useState } from "react";

// Custom file input matching the Heritage Press look. Wraps a hidden native input
// so it still submits as a real file field inside a multipart <Form>.
export function FilePicker({
  name,
  accept,
  label = "Choose PDF…",
  multiple = false,
}: {
  name: string;
  accept?: string;
  /** What the button says. A résumé and a migration file are not the same ask. */
  label?: string;
  /** Several at once — the screenshots of one interview invite, say. */
  multiple?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const chosen = names.length
    ? names.length <= 2
      ? names.join(", ")
      : `${names[0]}, ${names[1]} and ${names.length - 2} more`
    : multiple
      ? "no files chosen"
      : "no file chosen";
  return (
    <div className="filepick">
      <input
        ref={ref}
        type="file"
        name={name}
        accept={accept}
        multiple={multiple}
        className="filepick-input"
        onChange={(e) => setNames([...(e.target.files ?? [])].map((f) => f.name))}
      />
      <button type="button" className="filepick-btn" onClick={() => ref.current?.click()}>
        {label}
      </button>
      <span className={`filepick-name ${names.length ? "has" : ""}`}>{chosen}</span>
    </div>
  );
}
