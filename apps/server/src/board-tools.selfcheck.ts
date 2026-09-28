import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptySnapshot, type WorldServerMessage } from "@sfab-bench/contract";

import { boardTools } from "./board-tools";
import { closeRootWatches } from "./projects";
import { runViewerContext } from "./viewer-context";
import {
  attachWorld,
  boardRx,
  stopWorld,
  type WorldHandle,
} from "./world/host";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function waitUntil(
  pred: () => boolean,
  label: string,
  ms = 8000
): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timed out: ${label}`));
    }, ms);
    const poll = setInterval(() => {
      if (!pred()) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 15);
  });
}

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const root = mkdtempSync(join(tmpdir(), "sfab-board-tools-"));
cpSync(armDir, root, { recursive: true });
const events: WorldServerMessage[] = [];
const held: { handle: WorldHandle | null } = { handle: null };

try {
  expect(
    typeof boardTools.read_serial.execute === "function",
    "read_serial runs on the server"
  );
  expect(
    typeof boardTools.send_serial.execute === "function",
    "send_serial runs on the server"
  );

  await runViewerContext(
    {
      root,
      file: "",
      snapshot: emptySnapshot(),
      show: () => {},
    },
    async () => {
      const escaped = await boardTools.read_serial.execute!(
        { world: "../parts/sfab/arm-bench@1.0.0.json", board: "uno" },
        {} as never
      );
      expect(
        escaped &&
          "error" in escaped &&
          String(escaped.error).includes("escapes"),
        `bad world path: ${JSON.stringify(escaped)}`
      );

      const missing = await boardTools.read_serial.execute!(
        { world: "parts/sfab/arm-bench@1.0.0.json", board: "no-such" },
        {} as never
      );
      expect(
        missing &&
          "error" in missing &&
          String(missing.error).includes("no board"),
        `bad board: ${JSON.stringify(missing)}`
      );

      const attached = await attachWorld(
        root,
        "parts/sfab/arm-bench@1.0.0.json",
        {
          sender: { kind: "loopback", label: "Mac" },
          onEvent(event) {
            events.push(event);
          },
        }
      );
      if ("error" in attached) throw new Error(attached.error);
      held.handle = attached;
      const booted = events.find((event) => event.type === "state");
      expect(
        booted?.type === "state" && booted.state.playing === false,
        "tool load stays paused"
      );

      attached.step(3500);
      await waitUntil(
        () =>
          events.some(
            (event) =>
              event.type === "state" &&
              event.state.simTime.toFixed(3) === "3.500"
          ),
        "tools world stepped",
        30000
      );

      const read = await boardTools.read_serial.execute!(
        { world: "parts/sfab/arm-bench@1.0.0.json", board: "uno" },
        {} as never
      );
      expect(
        read &&
          "text" in read &&
          typeof read.text === "string" &&
          read.text.includes("10\r\n") &&
          read.text.includes("90\r\n") &&
          read.text.includes("120\r\n"),
        `read_serial tail ${JSON.stringify(read)}`
      );
      const next =
        read && "next" in read && typeof read.next === "number" ? read.next : 0;
      const fresh = await boardTools.read_serial.execute!(
        { world: "parts/sfab/arm-bench@1.0.0.json", board: "uno", from: next },
        {} as never
      );
      expect(
        fresh && "text" in fresh && fresh.text === "",
        "from next is empty"
      );

      const commands = () =>
        events.filter((event) => event.type === "command").length;
      const before = commands();
      attached.play();
      await waitUntil(
        () =>
          events.some((event) => event.type === "state" && event.state.playing),
        "playing before the tool"
      );
      const during = await boardTools.read_serial.execute!(
        { world: "parts/sfab/arm-bench@1.0.0.json", board: "uno" },
        {} as never
      );
      expect(during && "text" in during, "read while playing");
      const playing = [...events]
        .reverse()
        .find((event) => event.type === "state");
      expect(
        playing?.type === "state" && playing.state.playing,
        "read_serial does not pause"
      );
      expect(
        commands() === before + 1,
        "read_serial does not send play or pause"
      );

      const sent = await boardTools.send_serial.execute!(
        {
          world: "parts/sfab/arm-bench@1.0.0.json",
          board: "uno",
          text: "ping",
        },
        {} as never
      );
      expect(sent && "ok" in sent && sent.ok === true, "send_serial writes");
      await waitUntil(
        () =>
          events.some(
            (event) =>
              event.type === "serial-sent" &&
              event.by.kind === "agent" &&
              event.text === "ping"
          ),
        "agent send is echoed"
      );
      const long = await boardTools.send_serial.execute!(
        {
          world: "parts/sfab/arm-bench@1.0.0.json",
          board: "uno",
          text: "x".repeat(8001),
        },
        {} as never
      );
      expect(
        long && "error" in long && String(long.error).includes("8000"),
        `long text: ${JSON.stringify(long)}`
      );
    }
  );
} finally {
  held.handle?.detach();
  await stopWorld(root, "parts/sfab/arm-bench@1.0.0.json");
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}

const rx = boardRx(root, "parts/sfab/arm-bench@1.0.0.json", "uno");
expect("error" in rx, "stopped world is not readable");

console.log("board-tools.selfcheck ok");
