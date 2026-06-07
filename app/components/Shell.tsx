import { Sidebar } from "./Sidebar";

// Page chrome: crop marks, the floating collapsible left sidebar, and the sheet.
// `wide` widens the sheet for the board.
export function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <>
      <span className="crop tl" />
      <span className="crop tr" />
      <span className="crop bl" />
      <span className="crop br" />
      <Sidebar />
      <div className={`sheet ${wide ? "wide" : ""}`}>{children}</div>
    </>
  );
}
