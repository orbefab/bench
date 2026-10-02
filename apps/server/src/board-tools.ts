import { SERIAL_TEXT_MAX } from "@sfab-bench/contract";
import { tool } from "ai";
import { z } from "zod";
import { viewerProjectRoot, WORLD_ARG } from "./viewer-context";
import { ensureWorldRun, readSerial, sendSerial } from "./world/host";

/** What an agent needs from the console, not the whole retained ring. */
const SERIAL_TAIL = 8_000;

export const boardTools = {
  read_serial: tool({
    description: `Read a board's serial output in a world. ${WORLD_ARG} Omit from for the tail. Pass the previous next to read only what is new. Does not play or pause.`,
    inputSchema: z.object({
      world: z.string(),
      board: z.string(),
      from: z.number().int().nonnegative().optional(),
    }),
    execute: async ({ world, board, from }) => {
      const root = viewerProjectRoot();
      if (!root) return { error: "no project open" };
      const opened = await ensureWorldRun(root, world);
      if ("error" in opened) return opened;
      const read = readSerial(root, world, board, from ?? 0);
      if ("error" in read) return read;
      if (from !== undefined) return read;
      const text =
        read.text.length > SERIAL_TAIL
          ? read.text.slice(-SERIAL_TAIL)
          : read.text;
      return {
        text,
        next: read.next,
        ...(read.dropped !== undefined ? { dropped: read.dropped } : {}),
      };
    },
  }),
  send_serial: tool({
    description: `Write text to a board's serial input. ${WORLD_ARG} The sender is the agent. Does not play or pause.`,
    inputSchema: z.object({
      world: z.string(),
      board: z.string(),
      text: z.string().max(SERIAL_TEXT_MAX),
    }),
    execute: async ({ world, board, text }) => {
      const root = viewerProjectRoot();
      if (!root) return { error: "no project open" };
      const opened = await ensureWorldRun(root, world);
      if ("error" in opened) return opened;
      return sendSerial(root, world, board, text, { kind: "agent" });
    },
  }),
};
