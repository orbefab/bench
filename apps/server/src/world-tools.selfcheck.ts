import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptySnapshot, type WorldServerMessage } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { runViewerContext } from "./viewer-context";
import {
  attachWorld,
  stopWorld,
  type WorldHandle,
  worldDocumentOpen,
  worldStepInFlight,
  worldWorkerCount,
} from "./world/host";
import { readDraft, writeDraft } from "./world/selfcheck-draft";
import { worldTools } from "./world-tools";

function msOf(simTime: number): number {
  return Math.round(simTime * 1000);
}

// ±4 µs is ADR 0009's measured band for an unmodified Servo.h sweep on
// avr8js (every completed pulse within it of 647, 1472 and 1781 µs).
function hasWidth(widths: number[], target: number): boolean {
  return widths.some((width) => Math.abs(width - target) <= 4);
}

type PulseRun = { pulseUs: number; commandDeg: number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorOf(value: unknown): string | null {
  if (!isRecord(value) || !("error" in value)) return null;
  return typeof value.error === "string" ? value.error : "error";
}

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const root = mkdtempSync(join(tmpdir(), "sfab-world-tools-"));
cpSync(armDir, root, { recursive: true });

const arm = readDraft(root, "parts/sfab/arm-bench@1.0.0.json");
const robot = arm.robots[0];
const uno = arm.boards[0];
const servo = arm.parts[0];
const supply = arm.supplies[0];
if (!robot || !uno || !servo?.drives || !supply) {
  throw new Error("fixture shape");
}
const two = structuredClone(arm);
two.robots = [
  { ...robot, id: "hold-arm" },
  {
    ...robot,
    id: "stall-arm",
    pose: { position: [0.3, 0, 0], rotation: [1, 0, 0, 0] },
  },
];
two.boards = [
  {
    ...uno,
    id: "hold",
    firmware: "firmware/hold/hold.hex",
    source: "firmware/hold/hold.ino",
  },
  {
    ...uno,
    id: "stall",
    firmware: "firmware/stall/stall.hex",
    source: "firmware/stall/stall.ino",
    pose: { position: [0.4, 0, 0.006], rotation: [1, 0, 0, 0] },
  },
];
two.parts = [
  {
    ...servo,
    id: "hold-servo",
    drives: { robot: "hold-arm", joint: "shoulder" },
  },
  {
    ...servo,
    id: "stall-servo",
    drives: { robot: "stall-arm", joint: "shoulder" },
  },
];
two.supplies = [
  { ...supply, id: "usb-hold" },
  { ...supply, id: "usb-stall" },
];
two.wires = [
  ["usb-hold.5V", "hold.5V"],
  ["usb-hold.GND", "hold.GND"],
  ["hold.D9", "hold-servo.signal"],
  ["hold.5V", "hold-servo.V+"],
  ["hold.GND", "hold-servo.GND"],
  ["usb-stall.5V", "stall.5V"],
  ["usb-stall.GND", "stall.GND"],
  ["stall.D9", "stall-servo.signal"],
  ["stall.5V", "stall-servo.V+"],
  ["stall.GND", "stall-servo.GND"],
];
writeDraft(root, "two.world.json", two);

const unpowered = structuredClone(arm);
unpowered.wires = unpowered.wires.filter(
  (wire) =>
    !(wire[0] === "usb.5V" && wire[1] === "uno.5V") &&
    !(wire[0] === "uno.5V" && wire[1] === "usb.5V")
);
writeDraft(root, "unpowered.world.json", unpowered);

const events: WorldServerMessage[] = [];
const held: WorldHandle[] = [];

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
    }, 10);
  });
}

function call(
  tool: { execute?: (input: never, options: never) => unknown },
  input: unknown
): Promise<unknown> {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute");
  return Promise.resolve(execute(input as never, {} as never));
}

// Other checks share this process; count workers from here.
const workersBefore = worldWorkerCount();

try {
  expect(
    typeof worldTools.world_status.execute === "function",
    "world_status runs on the server"
  );
  const closed = await call(worldTools.world_status, {
    world: "parts/sfab/arm-bench@1.0.0.json",
  });
  expect(
    errorOf(closed) === "no project open",
    `closed ${JSON.stringify(closed)}`
  );
  const closedRead = await call(worldTools.read_recording, {
    world: "parts/sfab/arm-bench@1.0.0.json",
    tracks: ["part:servo.pulseUs"],
  });
  expect(
    errorOf(closedRead) === "no project open",
    `closed read ${JSON.stringify(closedRead)}`
  );
  expect(worldWorkerCount() === workersBefore, "no project started a worker");

  await runViewerContext(
    {
      root,
      file: "",
      snapshot: emptySnapshot(),
      show: () => {},
    },
    async () => {
      const missing = await call(worldTools.world_status, {
        world: "missing.world.json",
      });
      const escaped = await call(worldTools.world_play, {
        world: "../parts/sfab/arm-bench@1.0.0.json",
      });
      const badPart = await call(worldTools.read_pulses, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        part: "no-such-servo",
      });
      const low = await call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 0,
      });
      const high = await call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 10_001,
      });
      const fraction = await call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 1.5,
      });
      const badTracks = [
        "part:servo.temperature",
        "widget:servo",
        "joint:elbow",
        "part:missing.pulseUs",
        "supply:usb.watts",
        "board:missing.pins",
      ];
      for (const track of badTracks) {
        const bad = await call(worldTools.read_recording, {
          world: "parts/sfab/arm-bench@1.0.0.json",
          tracks: [track],
        });
        expect(
          errorOf(bad) === `unknown track "${track}"`,
          `track ${track}: ${JSON.stringify(bad)}`
        );
      }
      expect(
        worldWorkerCount() === workersBefore,
        "an unknown track started a worker"
      );
      expect(
        !worldDocumentOpen(root, "parts/sfab/arm-bench@1.0.0.json"),
        "an unknown track opened the arm"
      );

      expect(errorOf(missing), `missing world ${JSON.stringify(missing)}`);
      expect(
        errorOf(escaped)?.includes("escapes"),
        `escaped world ${JSON.stringify(escaped)}`
      );
      expect(
        errorOf(badPart)?.includes("no part"),
        `unknown part ${JSON.stringify(badPart)}`
      );
      for (const bad of [low, high, fraction]) {
        expect(
          errorOf(bad)?.includes("1 to 10000"),
          `ms out of range ${JSON.stringify(bad)}`
        );
      }
      expect(worldWorkerCount() === workersBefore, "an error started a worker");
      expect(
        !worldDocumentOpen(root, "parts/sfab/arm-bench@1.0.0.json"),
        "an error opened the arm"
      );
      expect(
        !worldDocumentOpen(root, "missing.world.json"),
        "a missing world was opened"
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
      held.push(attached);

      const restarted = await call(worldTools.world_restart, {
        world: "parts/sfab/arm-bench@1.0.0.json",
      });
      expect(!errorOf(restarted), `restart ${JSON.stringify(restarted)}`);
      if (!isRecord(restarted) || !isRecord(restarted.recording)) {
        throw new Error("restart has no recording");
      }
      const firstId = restarted.recording.id;
      expect(typeof firstId === "string" && firstId.length > 0, "recording id");
      expect(restarted.playing === false, "restart stays paused");
      expect(msOf(Number(restarted.simTime)) === 0, "restart is sim time 0");
      expect(
        events.some((event) => event.type === "reloaded"),
        "a subscriber did not see the restart"
      );
      expect(
        events.some(
          (event) =>
            event.type === "state" &&
            event.state.recording?.id === firstId &&
            msOf(event.state.simTime) === 0
        ),
        "a subscriber did not see the new recording"
      );

      const stepped = await call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 3500,
      });
      expect(!errorOf(stepped), `step ${JSON.stringify(stepped)}`);
      if (!isRecord(stepped)) throw new Error("step did not return status");
      expect(stepped.playing === false, "step leaves the run paused");
      expect(
        msOf(Number(stepped.simTime)) === 3500,
        `step landed at ${String(stepped.simTime)}`
      );
      expect(
        Array.isArray(stepped.warnings) && stepped.warnings.length === 0,
        `hold warnings ${JSON.stringify(stepped.warnings)}`
      );
      const unoBoard = isRecord(stepped.boards) ? stepped.boards.uno : null;
      expect(
        isRecord(unoBoard) &&
          Array.isArray(unoBoard.pins) &&
          unoBoard.pins.some(
            (pin) => typeof pin === "string" && pin.startsWith("D9: out")
          ),
        `D9 was not driven ${JSON.stringify(unoBoard)}`
      );

      const pulses = await call(worldTools.read_pulses, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        part: "servo",
        from: 0,
        to: 3.5,
      });
      expect(!errorOf(pulses), `pulses ${JSON.stringify(pulses)}`);
      if (!isRecord(pulses) || !Array.isArray(pulses.pulses)) {
        throw new Error("read_pulses shape");
      }
      const widths = pulses.pulses.map((run) =>
        isRecord(run) ? Number(run.pulseUs) : Number.NaN
      );
      console.log(`hold pulses ${widths.join(", ")}`);
      expect(pulses.board === "uno" && pulses.pin === "D9", "servo pin");
      expect(hasWidth(widths, 647), `missing 647 in ${widths.join(", ")}`);
      expect(hasWidth(widths, 1472), `missing 1472 in ${widths.join(", ")}`);
      expect(hasWidth(widths, 1781), `missing 1781 in ${widths.join(", ")}`);
      for (const run of pulses.pulses as PulseRun[]) {
        if (Math.abs(run.pulseUs - 647) <= 4) {
          expect(
            run.commandDeg !== null && Math.abs(run.commandDeg - 10) < 0.2,
            `10° command ${run.commandDeg}`
          );
        }
      }

      const recorded = await call(worldTools.read_recording, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        from: 0,
        to: 3.5,
        tracks: ["part:servo.pulseUs"],
        maxFrames: 500,
      });
      expect(!errorOf(recorded), `recording ${JSON.stringify(recorded)}`);
      if (!isRecord(recorded) || !Array.isArray(recorded.frames)) {
        throw new Error("read_recording shape");
      }
      const recordedWidths: number[] = [];
      for (const frame of recorded.frames) {
        if (!isRecord(frame) || !isRecord(frame.parts)) continue;
        const row = frame.parts.servo;
        if (!isRecord(row) || typeof row.pulseUs !== "number") continue;
        recordedWidths.push(row.pulseUs);
        expect(
          Object.keys(row).every((key) => key === "pulseUs"),
          `pulse track kept ${Object.keys(row).join(", ")}`
        );
      }
      console.log(
        `recording pulses ${[...new Set(recordedWidths.map((width) => Math.round(width)))].join(", ")}`
      );
      expect(hasWidth(recordedWidths, 647), "recording missed 647");
      expect(hasWidth(recordedWidths, 1472), "recording missed 1472");
      expect(hasWidth(recordedWidths, 1781), "recording missed 1781");
      expect(
        Array.isArray(recorded.warnings) && recorded.warnings.length === 0,
        `recording warnings ${JSON.stringify(recorded.warnings)}`
      );
      // A supply track returns the field it names, and nothing more.
      for (const field of ["voltage", "minVoltage"]) {
        const only = await call(worldTools.read_recording, {
          world: "parts/sfab/arm-bench@1.0.0.json",
          from: 0,
          to: 0.5,
          tracks: [`supply:${supply.id}.${field}`],
          maxFrames: 20,
        });
        expect(!errorOf(only), `supply ${field} ${JSON.stringify(only)}`);
        const rows =
          isRecord(only) && Array.isArray(only.frames)
            ? only.frames.flatMap((frame) =>
                isRecord(frame) && isRecord(frame.supplies)
                  ? Object.values(frame.supplies)
                  : []
              )
            : [];
        expect(rows.length > 0, `supply ${field}: no rows`);
        for (const row of rows) {
          expect(
            isRecord(row) &&
              Object.keys(row).join() === field &&
              typeof row[field] === "number",
            `supply ${field} track kept ${JSON.stringify(row)}`
          );
        }
      }
      const manifest = recorded.manifest;
      expect(isRecord(manifest), "recording has no manifest");
      if (isRecord(manifest)) {
        expect(manifest.integrator === "implicitfast", "integrator");
        expect(
          manifest.mujoco === "3.14.0",
          `mujoco ${String(manifest.mujoco)}`
        );
        expect(
          manifest.avr8js === "0.21.1",
          `avr8js ${String(manifest.avr8js)}`
        );
        expect(manifest.timestep === 0.001, "timestep");
        expect(manifest.frameMs === 10, "frame period");
        expect(
          typeof manifest.worldSha256 === "string" &&
            manifest.worldSha256.length === 64,
          "world sha256"
        );
        const boards = manifest.boards;
        expect(
          Array.isArray(boards) &&
            boards.some(
              (board) =>
                isRecord(board) &&
                board.firmware === "firmware/hold/hold.hex" &&
                typeof board.sha256 === "string" &&
                board.sha256.length === 64
            ),
          `firmware ${JSON.stringify(boards)}`
        );
        const parts = manifest.parts;
        expect(
          isRecord(parts) &&
            isRecord(parts.sg90) &&
            parts.sg90.torqueNm === 0.176,
          `catalog ${JSON.stringify(parts)}`
        );
        console.log(
          `manifest: mujoco ${String(manifest.mujoco)} avr8js ${String(manifest.avr8js)} sha ${String(manifest.worldSha256).slice(0, 12)}`
        );
      }

      const beforePlay = events.length;
      const played = await call(worldTools.world_play, {
        world: "parts/sfab/arm-bench@1.0.0.json",
      });
      expect(
        isRecord(played) &&
          played.playing === true &&
          isRecord(played.lastCommand) &&
          played.lastCommand.command === "play" &&
          isRecord(played.lastCommand.by) &&
          played.lastCommand.by.kind === "agent",
        `play ${JSON.stringify(played)}`
      );
      const play = events
        .slice(beforePlay)
        .find((event) => event.type === "command" && event.command === "play");
      expect(
        play?.type === "command" && play.by.kind === "agent",
        "play did not name the agent"
      );

      const beforePause = events.length;
      const paused = await call(worldTools.world_pause, {
        world: "parts/sfab/arm-bench@1.0.0.json",
      });
      expect(
        isRecord(paused) && paused.playing === false,
        `pause ${JSON.stringify(paused)}`
      );
      const pause = events
        .slice(beforePause)
        .find((event) => event.type === "command" && event.command === "pause");
      expect(
        pause?.type === "command" && pause.by.kind === "agent",
        "pause did not name the agent"
      );

      const late: WorldServerMessage[] = [];
      const second = await attachWorld(
        root,
        "parts/sfab/arm-bench@1.0.0.json",
        {
          sender: { kind: "paired", label: "Quest" },
          onEvent(event) {
            late.push(event);
          },
        }
      );
      if ("error" in second) throw new Error(second.error);
      held.push(second);
      expect(
        late.some(
          (event) =>
            event.type === "command" &&
            event.command === "pause" &&
            event.by.kind === "agent"
        ),
        "a second subscriber did not see the agent pause"
      );

      const mid = await call(worldTools.world_status, {
        world: "parts/sfab/arm-bench@1.0.0.json",
      });
      if (!isRecord(mid) || typeof mid.simTime !== "number") {
        throw new Error(`status ${JSON.stringify(mid)}`);
      }
      expect(mid.playing === false, "status stayed paused");
      const origin = msOf(mid.simTime);
      const exact = await call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 200,
      });
      if (!isRecord(exact) || typeof exact.simTime !== "number") {
        throw new Error(`exact step ${JSON.stringify(exact)}`);
      }
      expect(exact.playing === false, "exact step kept the pause");
      expect(
        msOf(exact.simTime) === origin + 200,
        `exact step ${exact.simTime} from ${mid.simTime}`
      );

      const beforeStep = events.length;
      await call(worldTools.world_play, {
        world: "parts/sfab/arm-bench@1.0.0.json",
      });
      const steppedLive = await call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 50,
      });
      expect(
        isRecord(steppedLive) && steppedLive.playing === false,
        "step while playing did not pause"
      );
      const livePause = events
        .slice(beforeStep)
        .find((event) => event.type === "command" && event.command === "pause");
      expect(
        livePause?.type === "command" && livePause.by.kind === "agent",
        "step did not pause as the agent"
      );

      const beforeRestart = events.length;
      const again = await call(worldTools.world_restart, {
        world: "parts/sfab/arm-bench@1.0.0.json",
      });
      if (!isRecord(again) || !isRecord(again.recording)) {
        throw new Error(`second restart ${JSON.stringify(again)}`);
      }
      const nextId = again.recording.id;
      expect(
        typeof nextId === "string" && nextId !== firstId,
        "recording id was reused"
      );
      expect(msOf(Number(again.simTime)) === 0, "second restart time");
      const againEvents = events.slice(beforeRestart);
      expect(
        againEvents.some((event) => event.type === "reloaded"),
        "subscriber missed the second restart"
      );
      expect(
        againEvents.some(
          (event) =>
            event.type === "state" &&
            event.state.recording?.id === nextId &&
            msOf(event.state.simTime) === 0 &&
            event.state.playing === false
        ),
        "subscriber missed the fresh run"
      );

      const desktop = held[0];
      if (!desktop) throw new Error("no subscriber");
      const overlapping = call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 400,
      });
      await waitUntil(
        () => worldStepInFlight(root, "parts/sfab/arm-bench@1.0.0.json"),
        "agent step is in flight"
      );
      desktop.step(1000);
      const raced = await overlapping;
      expect(
        isRecord(raced) &&
          raced.playing === false &&
          msOf(Number(raced.simTime)) === 400,
        `overlapped step ${JSON.stringify(raced)}`
      );
      await waitUntil(
        () =>
          events.some(
            (event) =>
              event.type === "state" && msOf(event.state.simTime) === 1400
          ),
        "the other step landed",
        20000
      );

      const interrupted = call(worldTools.world_step, {
        world: "parts/sfab/arm-bench@1.0.0.json",
        ms: 8000,
      });
      await waitUntil(
        () => worldStepInFlight(root, "parts/sfab/arm-bench@1.0.0.json"),
        "long step is in flight"
      );
      const interruptStarted = Date.now();
      const restartDuring = call(worldTools.world_restart, {
        world: "parts/sfab/arm-bench@1.0.0.json",
      });
      const interruptedResult = await interrupted;
      const interruptWait = Date.now() - interruptStarted;
      expect(
        interruptWait < 2000,
        `restart during step waited ${interruptWait} ms`
      );
      expect(
        errorOf(interruptedResult)?.includes("reload"),
        `interrupted step ${JSON.stringify(interruptedResult)}`
      );
      const restartedDuring = await restartDuring;
      expect(
        !errorOf(restartedDuring),
        `restart during step ${JSON.stringify(restartedDuring)}`
      );

      const stallRestart = await call(worldTools.world_restart, {
        world: "parts/sfab/arm-stall@1.0.0.json",
      });
      expect(
        !errorOf(stallRestart),
        `stall restart ${JSON.stringify(stallRestart)}`
      );
      const stall = await call(worldTools.world_step, {
        world: "parts/sfab/arm-stall@1.0.0.json",
        ms: 2000,
      });
      expect(!errorOf(stall), `stall step ${JSON.stringify(stall)}`);
      if (!isRecord(stall) || !isRecord(stall.boards)) {
        throw new Error("stall status");
      }
      const stallBoard = stall.boards.uno;
      expect(
        isRecord(stallBoard) && Number(stallBoard.resets) >= 1,
        `stall resets ${JSON.stringify(stallBoard)}`
      );
      const stallRec = await call(worldTools.read_recording, {
        world: "parts/sfab/arm-stall@1.0.0.json",
        from: 0,
        to: 2,
        maxFrames: 500,
      });
      expect(!errorOf(stallRec), `stall recording ${JSON.stringify(stallRec)}`);
      if (!isRecord(stallRec) || !Array.isArray(stallRec.events)) {
        throw new Error("stall recording shape");
      }
      expect(
        stallRec.events.some(
          (event) => isRecord(event) && event.kind === "reset"
        ),
        "stall recording has no reset"
      );
      const sagged = Array.isArray(stallRec.frames)
        ? stallRec.frames.some((frame) => {
            if (!isRecord(frame) || !isRecord(frame.supplies)) return false;
            return Object.values(frame.supplies).some(
              (row) =>
                isRecord(row) &&
                typeof row.minVoltage === "number" &&
                row.minVoltage < 2.7
            );
          })
        : false;
      expect(sagged, "stall recording never went under 2.7 V");

      const twoStep = await call(worldTools.world_step, {
        world: "two.world.json",
        ms: 800,
      });
      expect(!errorOf(twoStep), `two step ${JSON.stringify(twoStep)}`);
      if (!isRecord(twoStep) || !isRecord(twoStep.parts)) {
        throw new Error("two status");
      }
      const holdPart = twoStep.parts["hold-servo"];
      const stallPart = twoStep.parts["stall-servo"];
      expect(
        isRecord(holdPart) &&
          holdPart.board === "hold" &&
          holdPart.pin === "D9",
        `hold part ${JSON.stringify(holdPart)}`
      );
      expect(
        isRecord(stallPart) &&
          stallPart.board === "stall" &&
          stallPart.pin === "D9",
        `stall part ${JSON.stringify(stallPart)}`
      );
      expect(
        isRecord(twoStep.joints) &&
          "hold-arm/shoulder" in twoStep.joints &&
          "stall-arm/shoulder" in twoStep.joints,
        "the two shoulders collapsed"
      );
      const holdPulses = await call(worldTools.read_pulses, {
        world: "two.world.json",
        part: "hold-servo",
        from: 0,
        to: 0.8,
      });
      const stallPulses = await call(worldTools.read_pulses, {
        world: "two.world.json",
        part: "stall-servo",
        from: 0,
        to: 0.8,
      });
      expect(!errorOf(holdPulses) && isRecord(holdPulses), "hold pulses");
      expect(!errorOf(stallPulses) && isRecord(stallPulses), "stall pulses");
      if (!isRecord(holdPulses) || !isRecord(stallPulses)) {
        throw new Error("two pulses");
      }
      expect(
        holdPulses.board === "hold" && holdPulses.pin === "D9",
        "hold wire"
      );
      expect(
        stallPulses.board === "stall" && stallPulses.pin === "D9",
        "stall wire"
      );
      const holdWidths = Array.isArray(holdPulses.pulses)
        ? holdPulses.pulses.map((run) =>
            isRecord(run) ? Number(run.pulseUs) : Number.NaN
          )
        : [];
      const stallWidths = Array.isArray(stallPulses.pulses)
        ? stallPulses.pulses.map((run) =>
            isRecord(run) ? Number(run.pulseUs) : Number.NaN
          )
        : [];
      console.log(
        `two pulses hold ${holdWidths.join(", ")} stall ${stallWidths.join(", ")}`
      );
      expect(hasWidth(holdWidths, 647), "hold servo missed 647");
      expect(!hasWidth(holdWidths, 2400), "hold servo saw the stall pulse");
      expect(hasWidth(stallWidths, 2400), "stall servo missed 2400");
      expect(!hasWidth(stallWidths, 647), "stall servo saw the hold pulse");

      const dead = await call(worldTools.world_status, {
        world: "unpowered.world.json",
      });
      expect(!errorOf(dead), `unpowered ${JSON.stringify(dead)}`);
      if (!isRecord(dead) || !isRecord(dead.boards)) {
        throw new Error("unpowered status");
      }
      const deadBoard = dead.boards.uno;
      expect(
        isRecord(deadBoard) &&
          deadBoard.running === false &&
          deadBoard.fault === "unpowered",
        `unpowered board ${JSON.stringify(deadBoard)}`
      );
      const notes = Array.isArray(dead.diagnostics) ? dead.diagnostics : [];
      expect(
        notes.some(
          (issue) =>
            isRecord(issue) &&
            typeof issue.message === "string" &&
            issue.message.includes("board uno: no supply reaches its 5V pin")
        ),
        `unpowered diagnostics ${JSON.stringify(notes)}`
      );
    }
  );
} finally {
  for (const handle of held) handle.detach();
  await stopWorld(root, "parts/sfab/arm-bench@1.0.0.json");
  await stopWorld(root, "parts/sfab/arm-stall@1.0.0.json");
  await stopWorld(root, "two.world.json");
  await stopWorld(root, "unpowered.world.json");
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}

expect(worldWorkerCount() === workersBefore, "a world worker was left behind");
console.log("world-tools.selfcheck ok");
