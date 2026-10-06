import { useXrSupport } from "@/hooks/useXrSupport";
import { enterAR, enterVR } from "@/xrStore";

export function useEnterStudio() {
  const { ar, vr, ready } = useXrSupport();
  const mode = vr ? "vr" : ar ? "ar" : null;
  const label = mode === "ar" ? "Enter AR" : "Enter Studio";
  let title = "Checking headset support.";
  if (ready && mode === null) {
    title = "This browser can't open a headset session.";
  } else if (ready) {
    title = label;
  }
  return {
    ready,
    available: ready && mode !== null,
    mode,
    label,
    title,
    enter: () => {
      if (mode === "vr") void enterVR();
      else if (mode === "ar") void enterAR();
    },
  };
}
