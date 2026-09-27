/**
 * Circuit parts, the Nano board netlist, and a breadboard LED.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  arduinoPinBit,
  type RecordingRead,
  type SnapshotFile,
  type WorldState,
} from "@sfab-bench/contract";

import { type CaptureConfig, captureFromConfig } from "./capture";
import { closeRootWatches } from "./projects";
import { LED_RED } from "./world/circuit/circuits";
import { Diode, Resistor, VSource } from "./world/circuit/elements";
import { Engine } from "./world/circuit/engine";
import { PIN_ROH } from "./world/circuit/pin";
import { boardStampOf, realize } from "./world/circuit-stamp";
import {
  type AttachWorldOptions,
  attachWorld,
  readRecording,
  stopWorld,
} from "./world/host";
import { loadWorldV2 } from "./world/parts/load";
import { lockPathFor } from "./world/parts/lock";
import { sortValue } from "./world/parts/si";
import { catalogRoot, planWorld } from "./world/plan";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit } from "./world/rail-circuit";
import { tableLawOf, tableVoltage } from "./world/snapshot-law";

const NANO_STAMP = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
  boardId: "nano",
});
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const BAND = 0.005;

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function ledDeck(board: number): number {
  const diode = new Diode("led", "a", "0", LED_RED);
  const engine = new Engine(
    [
      new VSource("vs", "src", "0", { kind: "dc", value: board }),
      new Resistor("rp", "src", "pin", PIN_ROH),
      new Resistor("rled", "pin", "a", 1000),
      diode,
    ],
    { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
  );
  engine.operatingPoint();
  return diode.amps;
}

function nanoLaw() {
  const file = join(
    catalogRoot(),
    "snapshots",
    "sfab",
    "nano-usb-5v@1.0.0.json"
  );
  const law = tableLawOf(JSON.parse(readFileSync(file, "utf8")));
  if (!law) throw new Error("nano usb snapshot has no table");
  return law;
}

{
  const stamp = NANO_STAMP;
  const ids = stamp.parts.map((part) => part.path).join(",");
  expect(ids.includes("nano.s4"), `stamp missing s4: ${ids}`);
  expect(ids.includes("nano.c106"), `stamp missing c106: ${ids}`);
  expect(ids.includes("nano.led"), `stamp missing led: ${ids}`);
  const usb = realize(stamp, "usb", {
    roh: 25,
    rol: 23,
    rpu: 35000,
    rLeak: 5e6,
  });
  const header = realize(stamp, "header", {
    roh: 25,
    rol: 23,
    rpu: 35000,
    rLeak: 5e6,
  });
  expect(
    usb.elements.some((el) => el.id === "nano.s4"),
    "usb feed dropped s4"
  );
  expect(
    !header.elements.some((el) => el.id === "nano.s4"),
    "header feed kept s4"
  );
  expect(
    header.feedNode === header.boardNode,
    "header feed is not the 5V node"
  );
  console.log(
    "components: resistor capacitor diode led stamp; " +
      `usb keeps s4 on ${usb.feedNode}, header prunes it`
  );
}

{
  const rail = createRailCircuit({
    vNom: 5,
    rSeries: 0.5,
    iLimit: 0.9,
    motors: [],
    stamp: NANO_STAMP,
    feed: "header",
  });
  rail.setFixed(NANO_BOARD_A);
  rail.setD13("high");
  for (let i = 0; i < 40; i++) rail.solve();
  const alias = rail.leds["nano.led"];
  expect(alias !== undefined, "header rail has no nano.led");
  expect(
    alias === rail.ledCurrent,
    `leds alias ${alias} A is not ledCurrent ${rail.ledCurrent} A`
  );
  console.log(
    `leds alias: nano.led ${(alias * 1000).toFixed(2)} mA equals ledCurrent`
  );
}

{
  const planned = planWorld(nanoDir, "nano-led.world.json");
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const board = planned.plan.boards.find((item) => item.id === "nano");
  expect(board?.stamp, "nano-led has no stamp");
  expect(board.pins.VBUS === undefined, "VBUS is a wiring pin");
  const boxes = planned.plan.boxes ?? [];
  expect(
    boxes.some((box) => box.id === "r"),
    "resistor box missing"
  );
  expect(
    boxes.some((box) => box.id === "led"),
    "led box missing"
  );
  const bit = arduinoPinBit("D9");
  expect(bit !== undefined, "D9 has no bit");
  const rail = createRailCircuit({
    vNom: 5,
    rSeries: 0.5,
    iLimit: 0.9,
    motors: [],
    stamp: board.stamp,
    feed: "usb",
    pin: board.pin,
    ledAlias: "nano.led",
  });
  rail.setFixed(board.current);
  rail.setDrive(bit, "high");
  for (let i = 0; i < 40; i++) rail.solve();
  const on = rail.leds.led;
  expect(on !== undefined && on > 0.001, `breadboard LED ${on} A`);
  const deck = ledDeck(rail.boardVoltage);
  const onErr = Math.abs(on - deck) / deck;
  expect(onErr <= BAND, `LED on ${on} A vs deck ${deck} A (${onErr})`);
  let sum = 0;
  const period = 20;
  for (let i = 0; i < period; i++) {
    rail.setDrive(bit, i < period / 2 ? "high" : "low");
    rail.solve();
    sum += rail.leds.led ?? 0;
  }
  const avg = sum / period;
  const avgErr = Math.abs(avg - 0.5 * on) / on;
  expect(avgErr <= BAND, `LED average ${avg} A vs half of ${on} A`);
  console.log(
    `breadboard LED: class 2 on ${(on * 1000).toFixed(2)} mA ` +
      `(${(onErr * 100).toFixed(3)}% vs pin deck), ` +
      `pwm average ${(avgErr * 100).toFixed(3)}%`
  );
}

async function runLed(
  project: string,
  world: string,
  ms: number
): Promise<RecordingRead> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const options: AttachWorldOptions = {};
  const attached = await attachWorld(
    project,
    world,
    {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        if (event.type === "error") {
          seen.failed =
            event.message ??
            event.errors.map((item) => item.message).join("; ");
        }
        if (event.type === "state") seen.state = event.state;
      },
    },
    options
  );
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const read = await readRecording(project, world, {
      from: 0,
      to: ms / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    return read;
  } finally {
    attached.detach();
    await stopWorld(project, world);
    closeRootWatches();
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "sfab-led-"));
  try {
    cpSync(nanoDir, root, { recursive: true });
    const class2 = await runLed(root, "nano-led.world.json", 500);
    const frame = class2.frames.find((item) => item.boards.nano?.leds?.led);
    expect(frame, "class 2 recording has no leds.led");
    const alias = frame.boards.nano?.ledCurrent;
    const onboard = frame.boards.nano?.leds?.["nano.led"];
    expect(
      alias !== undefined && onboard !== undefined && alias === onboard,
      `recorded alias ${alias} is not leds nano.led ${onboard}`
    );
    const worldFile = join(root, "nano-led.world.json");
    writeFileSync(
      worldFile,
      readFileSync(worldFile, "utf8").replace(
        '"behaviour": 2',
        '"behaviour": 1'
      )
    );
    const loaded = loadWorldV2(worldFile, {
      catalogDir: catalogRoot(),
      assetRoot: root,
    });
    if (!loaded.lock) throw new Error("class 1 nano-led did not lock");
    writeFileSync(
      lockPathFor(worldFile),
      `${JSON.stringify(sortValue(loaded.lock), null, 2)}\n`
    );
    const class1 = await runLed(root, "nano-led.world.json", 500);
    expect(
      class1.frames.some((item) => (item.boards.nano?.leds?.led ?? 0) > 0),
      "class 1 recording has no breadboard LED current"
    );
    const planned1 = planWorld(root, "nano-led.world.json");
    if (!planned1.ok) {
      throw new Error(planned1.errors.map((item) => item.message).join("; "));
    }
    const board1 = planned1.plan.boards.find((item) => item.id === "nano");
    expect(
      board1?.stamp && board1.boardCircuit?.startsWith("snapshot:"),
      "class 1 lost the snapshot"
    );
    const bit = arduinoPinBit("D9");
    expect(bit !== undefined, "D9 has no bit");
    const snap = createRailCircuit({
      vNom: 5,
      rSeries: 0.5,
      iLimit: 0.9,
      motors: [],
      boardPath: "nano-snapshot",
      law: nanoLaw(),
      stamp: board1.stamp,
      feed: "header",
      pin: board1.pin,
      ledAlias: "nano.led",
    });
    snap.setFixed(board1.current);
    snap.setDrive(bit, "high");
    for (let i = 0; i < 40; i++) snap.solve();
    const snapOn = snap.leds.led ?? 0;
    const snapDeck = ledDeck(snap.boardVoltage);
    const snapErr = Math.abs(snapOn - snapDeck) / snapDeck;
    expect(snapErr <= BAND, `class 1 LED ${snapOn} A vs deck ${snapDeck} A`);
    console.log(
      "breadboard LED worlds: class 2 and class 1 record leds.led; " +
        `class 1 on ${(snapOn * 1000).toFixed(2)} mA ` +
        `(${(snapErr * 100).toFixed(3)}%); leds nano.led equals ledCurrent`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const catalog = catalogRoot();
  const part = JSON.parse(
    readFileSync(
      join(catalog, "parts", "sfab", "nano-ch340@1.0.0.json"),
      "utf8"
    )
  ) as {
    id: string;
    axes: {
      behaviour: {
        "2": {
          variants: {
            circuits: {
              board: {
                instances: Record<
                  string,
                  { part: string; params?: { R: number } }
                >;
                wires: string[][];
              };
            };
          };
        };
      };
    };
  };
  const id = "sfab/nano-1n4148@1.0.0";
  part.id = id;
  const board = part.axes.behaviour["2"].variants.circuits.board;
  // The 1N4148's open-circuit point does not return from gmin. A 1 MΩ
  // on the rail is about 5 µA at 5 V, far below the 0.1 A comparison.
  board.instances.s4.part = "sfab/diode-1n4148@1.0.0";
  board.instances.bleed = { part: "sfab/resistor@1.0.0", params: { R: 1e6 } };
  board.wires.push(["c106.A", "bleed.A"], ["c106.B", "bleed.B"]);
  const root = mkdtempSync(join(tmpdir(), "sfab-capture-board-"));
  try {
    const dir = join(root, "parts", "sfab");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nano-1n4148@1.0.0.json"), JSON.stringify(part));
    const config = JSON.parse(
      readFileSync(join(catalog, "fixtures", "capture.config.json"), "utf8")
    ) as CaptureConfig;
    config.part = id;
    config.cases = {};
    const out = join(root, "snap.json");
    await captureFromConfig({
      config,
      libraryDir: root,
      outFile: out,
      freeRun: false,
    });
    const snap = JSON.parse(readFileSync(out, "utf8")) as SnapshotFile;
    const nano = JSON.parse(
      readFileSync(
        join(catalog, "snapshots", "sfab", "nano-usb-5v@1.0.0.json"),
        "utf8"
      )
    ) as SnapshotFile;
    const testLaw = tableLawOf(snap);
    const nanoLaw = tableLawOf(nano);
    expect(testLaw && nanoLaw, "capture table");
    if (!testLaw || !nanoLaw) throw new Error("capture table");
    const testV = tableVoltage(testLaw, 5, 0.1);
    const nanoV = tableVoltage(nanoLaw, 5, 0.1);
    expect(
      testV < nanoV - 0.05,
      `1N4148 board ${testV} V is not below the SS14 board ${nanoV} V`
    );
    expect(snap.quality === "Q1", `lint granted ${snap.quality}`);
    console.log(
      `capture 1n4148 board: lint ${snap.quality}, ` +
        `0.1 A ${testV.toFixed(3)} V vs nano ${nanoV.toFixed(3)} V ` +
        `(s4 is 1N4148; 1 MΩ holds the open point)`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
