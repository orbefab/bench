/** `path:<name>` on a firmware variant's `boardCircuit`. The Uno cable is `path:uno-usb`. */
export function pathRefOf(boardCircuit: string | null): string | null {
  if (!boardCircuit?.startsWith("path:")) return null;
  const name = boardCircuit.slice("path:".length);
  return name.length > 0 ? name : null;
}
