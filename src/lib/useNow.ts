import { useEffect, useState } from 'react';

// A "now" that actually moves: re-renders the component on an interval so
// aging labels and day boundaries don't freeze at whatever time the view was
// mounted (a tab left open overnight must roll into the new day on its own).
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
