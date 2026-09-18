export function Icon({ name }: { name: "grid" | "agents" | "health" | "arrow" | "plus" }) {
  const paths = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    agents: "M8 4h8v8H8z M4 20v-3a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3 M12 1v3 M10 8h.01 M14 8h.01",
    health: "M2 12h4l3-8 6 16 3-8h4",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    plus: "M12 5v14 M5 12h14",
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
