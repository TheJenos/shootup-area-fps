import { useEffect, useState } from 'react';

/**
 * Seconds left until `until` (a performance.now() time, ms), in tenths, 0 once it's passed. Ticks
 * ten times a second while it's running, re-rendering only the component that asked, so a timer
 * on screen doesn't mean the whole HUD re-rendering ten times a second.
 */
export function useCountdown(until: number): number {
  const left = () => Math.max(0, Math.ceil((until - performance.now()) / 100) / 10);
  const [value, setValue] = useState(left);
  useEffect(() => {
    setValue(left());
    if (until <= performance.now()) return;
    const timer = setInterval(() => {
      const l = left();
      setValue(l);
      if (l <= 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
    // `left` is derived from `until` alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return value;
}
