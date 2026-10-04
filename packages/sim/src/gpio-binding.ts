/**
 * Which board GPIO a part's port reaches, read from the resolved
 * electrical nets once every board is planned (layered-sim M3a). A net
 * holds a shell's port and the inner port it exposes, so neither an
 * instance name nor a transparent shell changes the answer. One digital
 * board pin on the net binds. None leaves the port unbound. More than one
 * is not supported: the port stays unbound and the lookup says why.
 */
import { pinIndex } from "@sfab-bench/contract";
import type { LiveNet } from "@sfab-bench/parts";

export type GpioPin = { boardId: string; pin: string; bit: number };

/** A planned board as the index reads it. */
export type GpioHost = {
  id: string;
  pins: Record<string, { digital: boolean }>;
  pinOrder: readonly string[];
};

/** The bound pin, or null with `detail` set when the net is ambiguous. */
export type GpioReach = { pin: GpioPin | null; detail?: string };

export type GpioLookup = (path: string, port: string) => GpioReach;

export function gpioIndex(
  nets: readonly LiveNet[],
  boards: readonly GpioHost[]
): GpioLookup {
  const byId = new Map(boards.map((board) => [board.id, board]));
  const reach = new Map<string, GpioPin[]>();
  for (const net of nets) {
    if (net.domain !== "electrical") continue;
    const pins: GpioPin[] = [];
    for (const end of net.ports) {
      const board = byId.get(end.path);
      if (!board?.pins[end.port]?.digital) continue;
      const bit = pinIndex(board.pinOrder, end.port);
      if (bit === undefined) continue;
      if (pins.some((p) => p.boardId === board.id && p.pin === end.port)) {
        continue;
      }
      pins.push({ boardId: board.id, pin: end.port, bit });
    }
    for (const end of net.ports) reach.set(end.full, pins);
  }
  return (path, port) => {
    const pins = reach.get(`${path}.${port}`) ?? [];
    if (pins.length <= 1) return { pin: pins[0] ?? null };
    const names = pins.map((p) => `${p.boardId}.${p.pin}`).join(", ");
    return {
      pin: null,
      detail: `${port} reaches ${pins.length} board pins (${names}); one is supported`,
    };
  };
}
