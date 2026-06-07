import { useRef, useState } from "react";

// Custom file input matching the Heritage Press look. Wraps a hidden native input
// so it still submits as a real file field inside a multipart <Form>.
export function FilePicker({ name, accept }: { name: string; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [fname, setFname] = useState<string | null>(null);
  return (
    <div className="filepick">
      <input
        ref={ref}
        type="file"
        name={name}
        accept={accept}
        className="filepick-input"
        onChange={(e) => setFname(e.target.files?.[0]?.name ?? null)}
      />
      <button type="button" className="filepick-btn" onClick={() => ref.current?.click()}>
        Choose PDF…
      </button>
      <span className={`filepick-name ${fname ? "has" : ""}`}>{fname ?? "no file chosen"}</span>
    </div>
  );
}
