import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";

/**
 * Turns the orbit camera off for the length of a drag and gives it back as
 * it was. `pause` twice keeps the first state, and `resume` with nothing
 * paused does nothing. The orbit is given back when the owner unmounts.
 */
export function useOrbitPause(): { pause: () => void; resume: () => void } {
  const orbit = useThree((s) => s.controls) as { enabled?: boolean } | null;
  const was = useRef<boolean | undefined>(undefined);
  const pauser = useMemo(
    () => ({
      pause: () => {
        if (!orbit || was.current !== undefined) return;
        was.current = orbit.enabled;
        orbit.enabled = false;
      },
      resume: () => {
        if (orbit && was.current !== undefined) orbit.enabled = was.current;
        was.current = undefined;
      },
    }),
    [orbit]
  );
  useEffect(() => pauser.resume, [pauser]);
  return pauser;
}
