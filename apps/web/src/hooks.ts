import { useEffect, useState } from "react";

/**
 * Returns the current epoch ms, refreshed every `intervalMs`.
 * Pass enabled=false to pause the ticker (e.g. nothing is running).
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}
