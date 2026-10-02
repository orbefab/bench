/**
 * Circuit parts, the Nano board netlist, and a breadboard LED.
 */
import { ok as expect } from "node:assert/strict";
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
  pinIndex,
  type RecordingRead,
  type SnapshotFile,
  type WorldState,
} from "@sfab-bench/contract";
import {
  AVR_PIN,
  Diode,
  Engine,
  gminFallbackCalls,
  ISource,
  LED_RED,
  PIN_ROH,
  Resistor,
  tableVoltage,
  VSource,
} from "@sfab-bench/engine-circuit";
import {
  loadWorldV2,
  lockPathFor,
  sortValue,
  tableLawOf,
} from "@sfab-bench/parts";
import { type CaptureFile, captureFromConfig } from "./capture";
import { closeRootWatches } from "./projects";
import { boardStampOf, realize } from "./world/circuit-stamp";
import {
  type AttachWorldOptions,
  attachWorld,
  readRecording,
  stopWorld,
} from "./world/host";
import { nodeStore } from "./world/node-store";
import { catalogRoot, planWorld } from "./world/plan";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit } from "./world/rail-circuit";

const NANO_STAMP = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
  boardId: "nano",
});
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const BAND = 0.005;

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

{
  const stamp = NANO_STAMP;
  const ids = stamp.parts.map((part) => part.path).join(",");
  expect(ids.includes("nano.power.s4"), `stamp missing s4: ${ids}`);
  expect(ids.includes("nano.power.c106"), `stamp missing c106: ${ids}`);
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
    usb.elements.some((el) => el.id === "nano.power.s4"),
    "usb feed dropped s4"
  );
  expect(
    !header.elements.some((el) => el.id === "nano.power.s4"),
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
  rail.takeLedFrame();
  for (let i = 0; i < 10; i++) rail.solve();
  const steadyEnd = rail.leds["nano.led"] ?? 0;
  const steady = rail.takeLedFrame();
  expect(
    steady.leds["nano.led"] === steadyEnd && steady.ledCurrent === steadyEnd,
    `D13 frame mean ${steady.ledCurrent} A moved from ${steadyEnd} A`
  );
  console.log(
    `D13 steady on ${(steadyEnd * 1000).toFixed(4)} mA, frame mean unchanged`
  );
}

{
  const planned = planWorld(nanoDir, "parts/sfab/nano-led@1.0.0.json");
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
  const bit = pinIndex(board.pinOrder, "D9");
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
    const class2 = await runLed(root, "parts/sfab/nano-led@1.0.0.json", 500);
    const frame = class2.frames.find((item) => item.boards.nano?.leds?.led);
    expect(frame, "class 2 recording has no leds.led");
    const alias = frame.boards.nano?.ledCurrent;
    const onboard = frame.boards.nano?.leds?.["nano.led"];
    expect(
      alias !== undefined && onboard !== undefined && alias === onboard,
      `recorded alias ${alias} is not leds nano.led ${onboard}`
    );
    const worldFile = join(root, "parts/sfab/nano-led@1.0.0.json");
    writeFileSync(
      worldFile,
      readFileSync(worldFile, "utf8").replace(
        '"behaviour": 2',
        '"behaviour": 1'
      )
    );
    const loaded = loadWorldV2(worldFile, {
      store: nodeStore,
      catalogDir: catalogRoot(),
      assetRoot: root,
    });
    if (!loaded.lock) throw new Error("class 1 nano-led did not lock");
    writeFileSync(
      lockPathFor(worldFile),
      `${JSON.stringify(sortValue(loaded.lock), null, 2)}\n`
    );
    const class1 = await runLed(root, "parts/sfab/nano-led@1.0.0.json", 500);
    expect(
      class1.frames.some((item) => (item.boards.nano?.leds?.led ?? 0) > 0),
      "class 1 recording has no breadboard LED current"
    );
    const planned1 = planWorld(root, "parts/sfab/nano-led@1.0.0.json");
    if (!planned1.ok) {
      throw new Error(planned1.errors.map((item) => item.message).join("; "));
    }
    const board1 = planned1.plan.boards.find((item) => item.id === "nano");
    expect(board1?.stamp?.netlist === true, "class 1 lost the board netlist");
    if (!board1?.stamp) throw new Error("class 1 lost the board netlist");
    const bit = pinIndex(board1.pinOrder, "D9");
    expect(bit !== undefined, "D9 has no bit");
    const snap = createRailCircuit({
      vNom: 5,
      rSeries: 0.5,
      iLimit: 0.9,
      motors: [],
      stamp: board1.stamp,
      feed: "usb",
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

/** Arduino `map(angle, 0, 180, 544, 2400)`, integer division. */
function servoPulseUs(angle: number): number {
  return Math.trunc((angle * (2400 - 544)) / 180) + 544;
}

{
  const root = mkdtempSync(join(tmpdir(), "sfab-led-mean-"));
  try {
    cpSync(nanoDir, root, { recursive: true });
    const read = await runLed(root, "parts/sfab/nano-led@1.0.0.json", 1500);
    const pulseUs = servoPulseUs(10);
    const periodUs = 20_000;
    let serial = "";
    let wroteAt = Number.NaN;
    for (const event of read.events) {
      if (event.kind !== "serial" || event.board !== "nano") continue;
      serial += event.text ?? "";
      if (Number.isNaN(wroteAt) && serial.includes("10\r\n")) wroteAt = event.t;
    }
    console.log(
      `nano-led serial ${JSON.stringify(serial.slice(0, 24))} first line at ${
        Number.isNaN(wroteAt) ? "none" : `${wroteAt.toFixed(3)} s`
      }`
    );
    // The 10° pulse is one second. The timer is up by 60 ms, and the
    // next width starts at 1 s, so the closed form is taken on this span.
    const from = 0.06;
    const to = 1;
    let sum = 0;
    let volts = 0;
    let n = 0;
    let d13Min = Number.POSITIVE_INFINITY;
    let d13Max = 0;
    for (const frame of read.frames) {
      if (frame.t + 1e-9 < from || frame.t >= to - 1e-9) continue;
      const led = frame.boards.nano?.leds?.led ?? 0;
      sum += led;
      volts += frame.boards.nano?.voltage ?? 0;
      const onboard = frame.boards.nano?.leds?.["nano.led"] ?? 0;
      if (onboard < d13Min) d13Min = onboard;
      if (onboard > d13Max) d13Max = onboard;
      n += 1;
    }
    expect(n >= 90, `LED mean window has ${n} frames`);
    const mean = sum / n;
    const board = volts / n;
    const on = ledDeck(board);
    const closed = (pulseUs / periodUs) * on;
    const rel = closed > 0 ? Math.abs(mean - closed) / closed : 0;
    console.log(
      `nano-led D9 mean over 1 s ${(mean * 1e3).toFixed(4)} mA ` +
        `(${from.toFixed(3)}..${to.toFixed(3)} s), ` +
        `closed form ${(closed * 1e3).toFixed(4)} mA ` +
        `(${pulseUs} µs / ${periodUs} µs × ${(on * 1e3).toFixed(4)} mA), ` +
        `${(rel * 100).toFixed(2)}%`
    );
    expect(rel <= 0.02, `LED frame mean ${mean} A vs closed form ${closed} A`);
    console.log(
      `D13 in that window ${(d13Min * 1e3).toFixed(4)}..${(d13Max * 1e3).toFixed(4)} mA`
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
              netlist: {
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
  const board = part.axes.behaviour["2"].variants.circuits.netlist;
  const powerId = "sfab/nano-power-input-1n4148@1.0.0";
  const power = JSON.parse(
    readFileSync(
      join(catalog, "parts", "sfab", "nano-power-input@1.0.0.json"),
      "utf8"
    )
  ) as {
    id: string;
    axes: {
      behaviour: {
        "2": {
          variants: {
            netlist: {
              netlist: { instances: { s4: { part: string } } };
            };
          };
        };
      };
    };
  };
  power.id = powerId;
  power.axes.behaviour["2"].variants.netlist.netlist.instances.s4.part =
    "sfab/diode-1n4148@1.0.0";
  const powerInst = board.instances.power;
  if (!powerInst) throw new Error("nano board has no power group");
  powerInst.part = powerId;
  const root = mkdtempSync(join(tmpdir(), "sfab-capture-board-"));
  try {
    const dir = join(root, "parts", "sfab");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "nano-power-input-1n4148@1.0.0.json"),
      JSON.stringify(power)
    );
    writeFileSync(join(dir, "nano-1n4148@1.0.0.json"), JSON.stringify(part));
    expect(
      gminFallbackCalls === 0,
      `gmin fallback ran ${gminFallbackCalls} times before the open diode`
    );
    console.log(`gmin fallback calls ${gminFallbackCalls}`);
    const stamp = boardStampOf(id, "circuits", {
      boardId: "nano",
      libraryDir: root,
    });
    const openAt = (supply: number, fallback: boolean) => {
      const realized = realize(stamp, "usb", AVR_PIN);
      const load = stamp.portNodes["5V"];
      if (!load) throw new Error("stamp has no 5V");
      const series = realized.elements.find(
        (el): el is Diode => el instanceof Diode && el.id.endsWith("s4")
      );
      if (!series) throw new Error("stamp has no series diode");
      const engine = new Engine(
        [
          new VSource("v", "src", "0", { kind: "dc", value: supply }),
          new Resistor("rs", "src", realized.feedNode, 0.5),
          ...realized.elements,
          new ISource("load", load, "0", { kind: "dc", value: 0 }),
        ],
        { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
      );
      engine.gminFallback = fallback;
      return { engine, series, load };
    };
    const blocked = openAt(4.75, false);
    let failure = "";
    try {
      blocked.engine.operatingPoint();
    } catch (err: unknown) {
      failure = err instanceof Error ? err.message : String(err);
    }
    expect(failure.length > 0, "open 1N4148 converged without the fallback");
    console.log(`open 1N4148 without bleed: ${failure}`);
    const opened = openAt(4.75, true);
    opened.engine.operatingPoint();
    const node = opened.engine.voltage(opened.load);
    const amps = opened.series.amps;
    expect(Math.abs(node - 4.75) < 1e-3, `open node ${node} V`);
    expect(Math.abs(amps) < 1e-6, `diode current ${amps} A`);
    expect(
      opened.engine.gminFloor === 0,
      `shunt floor ${opened.engine.gminFloor}`
    );
    console.log(
      `open 1N4148: converged, 5V ${node.toFixed(4)} V, ` +
        `diode ${amps.toExponential(2)} A, ` +
        `${opened.engine.newtonIters} iterations, floor 0`
    );
    const config = JSON.parse(
      readFileSync(join(catalog, "fixtures", "capture.config.json"), "utf8")
    ) as CaptureFile;
    const entry = config.entries.find(
      (row) => row.id === "sfab/nano-power-input@1.0.0"
    );
    if (!entry) throw new Error("nano-power-input capture entry missing");
    entry.part = powerId;
    entry.id = powerId;
    entry.cases = {};
    config.entries = [entry];
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
        join(catalog, "snapshots", "sfab", "nano-power-input@1.0.0.json"),
        "utf8"
      )
    ) as SnapshotFile;
    const testLaw = tableLawOf(snap);
    const nanoLaw = tableLawOf(nano);
    expect(testLaw && nanoLaw, "capture table");
    if (!testLaw || !nanoLaw) throw new Error("capture table");
    const testV = tableVoltage(testLaw, 0.1);
    const nanoV = tableVoltage(nanoLaw, 0.1);
    expect(
      testV > nanoV + 0.05,
      `1N4148 drop ${testV} V is not above the SS14 drop ${nanoV} V`
    );
    expect(snap.quality === "Q1", `lint granted ${snap.quality}`);
    console.log(
      `capture 1n4148 branch: lint ${snap.quality}, ` +
        `0.1 A drop ${testV.toFixed(3)} V vs nano ${nanoV.toFixed(3)} V (s4 is 1N4148)`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
