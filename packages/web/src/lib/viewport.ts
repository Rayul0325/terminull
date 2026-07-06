/**
 * Phone-breakpoint detection. INVARIANT (M9 W8): at the phone breakpoint the
 * app never mounts the tiled dockview workspace — sessions open as
 * full-screen views / bottom sheets instead. Tiling is a desktop affordance.
 */
import { useEffect, useState } from 'react';

export const PHONE_QUERY = '(max-width: 640px)';

/** Pure check (SSR/test-safe: no matchMedia → false = desktop). */
export function isPhoneViewport(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(PHONE_QUERY).matches;
}

/** Reactive phone-breakpoint hook. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState<boolean>(() => isPhoneViewport());
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(PHONE_QUERY);
    const onChange = (): void => setPhone(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}
