/**
 * VIN regulators. USB-only worlds stay on the captured branch. A supply
 * on VIN runs the onboard regulator.
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

import type { PartFile, RecordingRead, WorldState } from "@sfab-bench/contract";
import {
  AVR_PIN,
  Comparator,
  CurrentLoad,
  Diode,
  dropoutAt,
  Engine,
  type LdoParams,
  LdoRegulator,
  ldoBias,
  ldoRegulated,
  PmosChannel,
  Resistor,
  TheveninLimit,
  VSource,
} from "@sfab-bench/engine-circuit";
import { batteryFrom, ldoFrom } from "@sfab-bench/parts";
import { levelCard } from "../../web/src/lib/level-card";
import { type CaptureFile, captureFromConfig } from "./capture";
import { closeRootWatches } from "./projects";
import { boardStampOf, realize } from "./world/circuit-stamp";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { catalogRoot, planWorld } from "./world/plan";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit } from "./world/rail-circuit";
import { powerFeedsOf, powerIslands, suppliesOnPort } from "./world/wiring";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function partParams(id: string): LdoParams {
  const file = JSON.parse(
    readFileSync(join(catalogRoot(), "parts", "sfab", `${id}.json`), "utf8")
  ) as PartFile;
  const slot = file.axes?.behaviour?.["1"];
  const impl = slot?.variants[slot.default];
  if (impl?.kind !== "form") throw new Error(`${id} has no form`);
  const built = ldoFrom(impl.params, {});
  if (!built.ok) throw new Error(built.error);
  return built.params;
}

const ams = partParams("ams1117-5v0@1.0.0");
const lp = partParams("lp2985-3v3@1.0.0");

function solve(elements: ConstructorParameters<typeof Engine>[0]) {
  const engine = new Engine(elements, {
    method: "be",
    h: 1e-3,
    atol: 1e-14,
    rtol: 1e-12,
  });
  engine.operatingPoint();
  return engine;
}

{
  const open = new CurrentLoad("load", "out", "0", 0);
  open.amps = 0;
  const engine = solve([
    new VSource("src", "in", "0", { kind: "dc", value: 9 }),
    new LdoRegulator("u", "in", "out", "0", ams),
    open,
  ]);
  const out = engine.voltage("out");
  const pass = engine.branchCurrent("u");
  expect(Math.abs(out - ams.vOut) <= 1e-9, `open OUT ${out}`);
  expect(Math.abs(pass) <= 1e-9, `open current ${pass}`);
  const half = new CurrentLoad("load", "out", "0", 0);
  half.amps = 0.5;
  const loaded = solve([
    new VSource("src", "in", "0", { kind: "dc", value: 9 }),
    new LdoRegulator("u", "in", "out", "0", ams),
    half,
  ]);
  const atHalf = loaded.voltage("out");
  const want = ams.vOut - ams.rOut * 0.5;
  const dHalf = Math.abs(atHalf - want);
  expect(dHalf <= 1e-9, `500 mA Δ ${dHalf}`);
  const dropLoad = new CurrentLoad("load", "out", "0", 0);
  dropLoad.amps = 0.8;
  const dropped = solve([
    new VSource("src", "in", "0", { kind: "dc", value: 5 }),
    new LdoRegulator("u", "in", "out", "0", ams),
    dropLoad,
  ]);
  const sheet = dropoutAt(ams.dropout, 0.8).volts;
  const got = dropped.voltage("in") - dropped.voltage("out");
  expect(Math.abs(got - sheet) <= 1e-9, `dropout ${got} vs ${sheet}`);
  const limited = solve([
    new VSource("src", "in", "0", { kind: "dc", value: 9 }),
    new LdoRegulator("u", "in", "out", "0", ams),
    new Resistor("r", "out", "0", 0.01),
  ]);
  const held = limited.branchCurrent("u");
  expect(Math.abs(held - ams.iLimit) < 1e-4, `limit ${held}`);
  const delivered = -loaded.branchCurrent("src");
  const bias = delivered - loaded.branchCurrent("u");
  const biasLaw = ldoBias(ams.iGround, loaded.voltage("in"));
  expect(Math.abs(bias - ams.iGround) <= 1e-9, `iGround ${bias}`);
  expect(Math.abs(bias - biasLaw) <= 1e-12, `bias law ${biasLaw}`);
  expect(loaded.power().kcl < 1e-9, `kcl ${loaded.power().kcl}`);
  console.log(
    `regulator: OUT 0 A Δ ${(out - ams.vOut).toExponential(1)} V, 500 mA Δ ${dHalf.toExponential(1)} V, dropout ${got.toFixed(3)} V (datasheet ${sheet.toFixed(3)} V), limit ${held.toFixed(6)} A, iGround ${bias.toFixed(6)} A`
  );
}

function nanoRail(volts: number) {
  const stamp = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
    boardId: "nano",
  });
  const circuit = createRailCircuit({
    vNom: volts,
    rSeries: 0.05,
    iLimit: 2,
    motors: [],
    stamp,
    feed: "vin",
    pin: AVR_PIN,
  });
  circuit.setFixed(NANO_BOARD_A);
  circuit.setD13("low");
  for (let i = 0; i < 5; i++) circuit.solve();
  return circuit;
}

{
  const reg = nanoRail(9);
  const pass = reg.current - ams.iGround;
  const want = ldoRegulated(ams, reg.voltage, pass);
  const d = Math.abs(reg.boardVoltage - want);
  expect(d <= 1e-6, `nano 9 V Δ ${d}`);
  reg.setD13("high");
  reg.solve();
  const ledOn = reg.ledCurrent;
  reg.setD13("low");
  reg.solve();
  const ledOff = reg.ledCurrent;
  expect(ledOn > 0.001 && ledOff < ledOn * 0.1, `D13 ${ledOn} / ${ledOff}`);
  const sag = nanoRail(6);
  const sagPass = sag.current - ams.iGround;
  const sagWant = ldoRegulated(ams, sag.voltage, sagPass);
  const vReg = ams.vOut - ams.rOut * sagPass;
  const binds = sagWant < vReg - 1e-4;
  expect(Math.abs(sag.boardVoltage - sagWant) <= 1e-6, "nano 6 V law");
  expect(binds, "6 V did not enter dropout");
  console.log(
    `nano VIN 9 V: 5V ${reg.boardVoltage.toFixed(6)} V (regulation Δ ${d.toExponential(1)} V), D13 ${ledOn.toFixed(6)} A then ${ledOff.toFixed(6)} A; VIN 6 V: 5V ${sag.boardVoltage.toFixed(6)} V, dropout binds`
  );
}

{
  const stamp = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
    boardId: "nano",
  });
  const vbus = stamp.vbusNode;
  if (!vbus) throw new Error("nano has no VBUS");
  const realized = realize(stamp, "vin", AVR_PIN, { keep: [vbus] });
  const load = new CurrentLoad("load", realized.boardNode, "0", 0);
  load.amps = NANO_BOARD_A;
  const engine = solve([
    new TheveninLimit("usb", vbus, "0", 5, 0.5, 0.9),
    new TheveninLimit("vin", realized.feedNode, "0", 9, 0.05, 2),
    load,
    ...realized.elements,
  ]);
  const diode = realized.elements.find(
    (el): el is Diode => el instanceof Diode && el.id.endsWith(".s4")
  );
  const ldo = realized.elements.find(
    (el): el is LdoRegulator => el instanceof LdoRegulator
  );
  if (!diode || !ldo)
    throw new Error("nano dual is missing S4 or the regulator");
  const s4 = diode.amps;
  const pass = engine.branchCurrent(ldo.id);
  expect(pass > 0.02, `regulator pass ${pass}`);
  expect(Math.abs(s4) < 1e-3, `S4 ${s4}`);
  console.log(
    `nano USB and VIN 9 V: regulator ${pass.toFixed(6)} A, S4 ${s4.toExponential(2)} A, regulator supplies the board`
  );
}

{
  const file = JSON.parse(
    readFileSync(
      join(catalogRoot(), "parts", "sfab", "battery-2s-lipo@1.0.0.json"),
      "utf8"
    )
  ) as PartFile;
  const slot = file.axes?.behaviour?.["1"];
  const impl = slot?.variants[slot.default];
  if (impl?.kind !== "form") throw new Error("battery form");
  const built = batteryFrom(impl.params, {});
  if (!built.ok) throw new Error(built.error);
  const stamp = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
    boardId: "nano",
  });
  const circuit = createRailCircuit({
    vNom: 8.354,
    rSeries: built.params.rInternal,
    iLimit: 2,
    motors: [],
    stamp,
    feed: "vin",
    pin: AVR_PIN,
    battery: built.params,
  });
  circuit.setFixed(NANO_BOARD_A);
  circuit.setD13("low");
  const sample = (steps: number) => {
    for (let i = 0; i < steps; i++) circuit.solve();
    return { v: circuit.boardVoltage, soc: circuit.soc ?? Number.NaN };
  };
  const at1 = sample(1000);
  const at60 = sample(59_000);
  expect(at1.v > 4.9 && at1.v < 5.1, `battery 1 s ${at1.v}`);
  expect(at60.v > 4.9 && at60.v < 5.1, `battery 60 s ${at60.v}`);
  expect(at60.soc < at1.soc && at1.soc <= 1, `soc ${at1.soc} ${at60.soc}`);
  console.log(
    `nano 2S LiPo on VIN: 5V ${at1.v.toFixed(6)} V soc ${at1.soc.toFixed(6)} at 1 s, 5V ${at60.v.toFixed(6)} V soc ${at60.soc.toFixed(6)} at 60 s`
  );
}

function settle(
  elements: readonly Comparator[],
  channels: readonly PmosChannel[],
  engine: Engine
): void {
  const latch = () => {
    const voltage = (node: string) => engine.voltage(node);
    for (const channel of channels) channel.latch(voltage);
    for (const cmp of elements) cmp.latch(voltage);
  };
  let drop = false;
  for (const cmp of elements) if (cmp.apply()) drop = true;
  for (const channel of channels) if (channel.apply()) drop = true;
  if (drop) engine.dropFactor();
  engine.operatingPoint();
  latch();
  for (let i = 0; i < 8; i++) {
    drop = false;
    for (const cmp of elements) if (cmp.apply()) drop = true;
    for (const channel of channels) if (channel.apply()) drop = true;
    if (drop) engine.dropFactor();
    engine.stepFast();
    latch();
  }
}

function unoDual(vin: number) {
  const stamp = boardStampOf("sfab/uno-r3@1.0.0", "circuits", {
    boardId: "uno",
  });
  const vbus = stamp.vbusNode;
  if (!vbus) throw new Error("uno has no VBUS");
  const realized = realize(stamp, "vin", AVR_PIN, { keep: [vbus] });
  const load = new CurrentLoad("load", realized.boardNode, "0", 0);
  load.amps = 0.05;
  const engine = new Engine(
    [
      new TheveninLimit("usb", vbus, "0", 5, 0.5, 0.9),
      new TheveninLimit("vin", realized.feedNode, "0", vin, 0.05, 2),
      load,
      ...realized.elements,
    ],
    { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
  );
  const comparators = realized.elements.filter(
    (el): el is Comparator => el instanceof Comparator
  );
  const channels = realized.elements.filter(
    (el): el is PmosChannel => el instanceof PmosChannel
  );
  const ldo = realized.elements.find(
    (el): el is LdoRegulator =>
      el instanceof LdoRegulator && el.id.endsWith(".u1")
  );
  if (!ldo || channels.length !== 1) throw new Error("uno dual parts");
  settle(comparators, channels, engine);
  return {
    engine,
    on: channels[0]?.on === true,
    pass: engine.branchCurrent(ldo.id),
    usb: -engine.branchCurrent("usb"),
  };
}

{
  const hi = unoDual(9);
  const lo = unoDual(6);
  const vref = lp.vOut;
  const threshold = (vref * (10_000 + 10_000)) / 10_000;
  expect(Math.abs(threshold - 6.6) < 1e-9, `threshold ${threshold}`);
  expect(hi.on === false, "T1 stayed on at 9 V");
  expect(
    hi.pass > 0.04 && Math.abs(hi.usb) < 1e-3,
    `9 V feed ${hi.pass} ${hi.usb}`
  );
  expect(lo.on === true, "T1 stayed off below the threshold");
  console.log(
    `uno VIN 9 V with USB: T1 off, NCP1117 ${hi.pass.toFixed(6)} A, USB ${hi.usb.toExponential(2)} A; VIN 6 V: T1 on; threshold ${threshold.toFixed(3)} V = ${vref} V × (10 kΩ + 10 kΩ) / 10 kΩ`
  );
}

const nanoExample = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const armExample = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function scene(
  name: string,
  supply: string,
  volts: number,
  wire: string
): string {
  return `{
  "format": "sfab.part@1",
  "id": "sfab/${name}-scene@1.0.0",
  "type": "assembly",
  "foreign": false,
  "axes": {
    "behaviour": { "2": { "default": "netlist", "variants": { "netlist": {
      "kind": "composite", "omits": ["proof scene"],
      "netlist": {
        "instances": {
          "nano": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/blink/blink.hex", "source": "firmware/blink/blink.ino" } },
          "supply": { "part": "${supply}", "params": { "V": ${volts}, "Ilimit": 2 } }
        },
        "wires": [["supply.${wire}", "nano.VIN"], ["supply.GND", "nano.GND"]],
        "expose": {}
      }
    } } } },
    "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } },
    "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } }
  }
}`;
}

function writeWorld(
  dir: string,
  name: string,
  body: string,
  levels: string
): void {
  mkdirSync(join(dir, "parts", "sfab"), { recursive: true });
  cpSync(join(nanoExample, "firmware"), join(dir, "firmware"), {
    recursive: true,
  });
  writeFileSync(join(dir, "parts", "sfab", `${name}-scene@1.0.0.json`), body);
  writeFileSync(
    join(dir, `${name}.world.json`),
    `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { ${levels} } },
  "root": { "id": "scene", "part": "sfab/${name}-scene@1.0.0" }
}
`
  );
}

async function runProject(
  dir: string,
  world: string,
  ms: number,
  board: string
): Promise<{
  voltages: number[];
  leds: number[];
  resets: number;
  frames: RecordingRead["frames"];
  supplies: WorldState["supplies"];
}> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") seen.state = event.state;
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + Math.max(180_000, ms * 40);
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!seen.state || seen.state.simTime < ms / 1000 - 1e-3) {
      throw new Error(`${world} timed out`);
    }
    const read: RecordingRead | { error: string } = await readRecording(
      dir,
      world,
      { from: 0, to: ms / 1000 }
    );
    if ("error" in read) throw new Error(read.error);
    return {
      voltages: read.frames.map(
        (frame) => frame.boards[board]?.voltage ?? Number.NaN
      ),
      leds: read.frames.map(
        (frame) => frame.boards[board]?.leds?.[`${board}.led`] ?? Number.NaN
      ),
      resets: seen.state.boards[board]?.resets ?? 0,
      frames: read.frames,
      supplies: seen.state.supplies,
    };
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

const root = mkdtempSync(join(tmpdir(), "vin-reg-"));
try {
  writeWorld(
    root,
    "blink",
    scene("blink", "sfab/bench-supply@1.0.0", 9, "5V"),
    `"default": 1, "paths": { "nano": { "behaviour": 2 } }`
  );
  const blink = await runProject(root, "blink.world.json", 500, "nano");
  const minV = Math.min(...blink.voltages);
  const maxV = Math.max(...blink.voltages);
  const ledHi = blink.leds.some((amps) => amps > 0.001);
  const ledLo = blink.leds.some((amps) => amps < 0.0001);
  expect(minV > 4.99 && maxV < 5.05, `blink 5V ${minV} ${maxV}`);
  expect(ledHi && ledLo, `blink LED ${blink.leds.slice(0, 8).join(",")}`);
  expect(blink.resets === 0, `blink resets ${blink.resets}`);
  console.log(
    `nano blink on VIN 9 V: 5V ${minV.toFixed(4)}–${maxV.toFixed(4)} V, D13 blinked, resets ${blink.resets}`
  );

  writeWorld(
    root,
    "class1",
    scene("class1", "sfab/bench-supply@1.0.0", 9, "5V")
      .replace("firmware/blink/blink.hex", "firmware/hold/hold.hex")
      .replace("firmware/blink/blink.ino", "firmware/hold/hold.ino"),
    `"default": 1`
  );
  const planned = planWorld(root, "class1.world.json");
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const power = planned.plan.report?.levels.find(
    (row) => row.path === "nano.power" && row.axis === "behaviour"
  );
  const card = levelCard(planned.plan.report ?? null, "nano.power");
  const reason = card?.axes.find((row) => row.axis === "behaviour")?.reason;
  expect(power?.class === 2, `class ${power?.class}`);
  expect(power?.source === "fallback", `source ${power?.source}`);
  expect(power?.reason === "nearest runnable level", power?.reason ?? "");
  expect(reason === "nearest runnable level", reason ?? "");
  expect(
    planned.plan.boards.find((board) => board.id === "nano")?.vinFeed === true,
    "vin feed"
  );
  console.log(
    `class 1 with VIN driven: nano.power class ${power?.class}, warning ${power?.reason}, source ${power?.source}`
  );

  const armDir = join(root, "arm");
  cpSync(armExample, armDir, { recursive: true });
  const sceneFile = join(armDir, "parts", "sfab", "arm-stall-scene@1.0.0.json");
  const armPart = JSON.parse(readFileSync(sceneFile, "utf8")) as {
    axes: {
      behaviour: {
        "2": {
          variants: {
            netlist: {
              netlist: {
                instances: { bench: { params: { V: number; Ilimit: number } } };
                wires: [string, string][];
              };
            };
          };
        };
      };
    };
  };
  const net = armPart.axes.behaviour["2"].variants.netlist.netlist;
  net.instances.bench.params = { V: 9, Ilimit: 2 };
  net.wires = net.wires.map((pair) =>
    pair[0] === "bench.5V" && pair[1] === "uno.5V"
      ? ["bench.5V", "uno.VIN"]
      : pair
  );
  writeFileSync(sceneFile, `${JSON.stringify(armPart, null, 2)}\n`);
  rmSync(join(armDir, "arm-stall.world.lock.json"), { force: true });
  const armPlan = planWorld(armDir, "arm-stall.world.json");
  if (!armPlan.ok) {
    throw new Error(armPlan.errors.map((item) => item.message).join("; "));
  }
  const armFeeds = powerFeedsOf(armPlan.plan);
  const stall = await runProject(armDir, "arm-stall.world.json", 2000, "uno");
  const stallMin = Math.min(...stall.voltages);
  const servoPeak = stall.frames.reduce(
    (max, frame) => Math.max(max, frame.parts.servo?.maxCurrent ?? 0),
    0
  );
  const ncpPeak = stall.frames.reduce(
    (max, frame) => Math.max(max, frame.boards.uno?.regulatorMax ?? 0),
    0
  );
  const supplyPeak = stall.frames.reduce((max, frame) => {
    for (const supply of Object.values(frame.supplies)) {
      max = Math.max(max, supply.maxCurrent);
    }
    return max;
  }, 0);
  const start = stall.frames[0]?.joints.arm?.shoulder ?? 0;
  let travel = 0;
  for (const frame of stall.frames) {
    const angle = frame.joints.arm?.shoulder ?? start;
    travel = Math.max(travel, Math.abs(angle - start));
  }
  const travelDeg = (travel * 180) / Math.PI;
  const brown = stallMin < 2.675 || stall.resets > 0;
  expect(
    armFeeds.parts.servo === "bench",
    `servo feed ${armFeeds.parts.servo}`
  );
  expect(servoPeak > 0.2, `servo peak ${servoPeak} A is the idle board`);
  expect(ncpPeak > servoPeak && ncpPeak < 1.5, `NCP ${ncpPeak} A`);
  expect(
    !brown && stall.resets === 0,
    `brownout ${stallMin} resets ${stall.resets}`
  );
  console.log(
    `uno arm on VIN 9 V: servo feed ${armFeeds.parts.servo}, supply peak ${supplyPeak.toFixed(4)} A, servo peak ${servoPeak.toFixed(4)} A, NCP1117 peak ${ncpPeak.toFixed(4)} A (iLimit 1.5 A), shoulder ${travelDeg.toFixed(3)}°, minimum 5V ${stallMin.toFixed(4)} V, ${brown ? "browns out" : "does not brown out"}, resets ${stall.resets}`
  );

  const nanoDir = join(root, "nano");
  cpSync(nanoExample, nanoDir, { recursive: true });
  const nanoScene = join(
    nanoDir,
    "parts",
    "sfab",
    "nano-servo-scene@1.0.0.json"
  );
  const nanoPart = JSON.parse(readFileSync(nanoScene, "utf8")) as {
    axes: {
      behaviour: {
        "2": {
          variants: {
            netlist: {
              netlist: {
                instances: Record<string, Record<string, unknown>>;
                wires: [string, string][];
              };
            };
          };
        };
      };
    };
  };
  const nanoNet = nanoPart.axes.behaviour["2"].variants.netlist.netlist;
  nanoNet.instances.bench = {
    part: "sfab/bench-supply@1.0.0",
    pose: {
      position: [0.042, 0, 0.0025],
      rotation: [1, 0, 0, 0],
    },
    params: { V: 9, Ilimit: 2 },
  };
  delete nanoNet.instances.usb;
  nanoNet.wires = nanoNet.wires.map((pair) => {
    const mapped = pair.map((end) =>
      end === "usb.5V" ? "bench.5V" : end === "usb.GND" ? "bench.GND" : end
    ) as [string, string];
    return mapped[0] === "bench.5V" && mapped[1] === "nano.5V"
      ? ["bench.5V", "nano.VIN"]
      : mapped;
  });
  writeFileSync(nanoScene, `${JSON.stringify(nanoPart, null, 2)}\n`);
  rmSync(join(nanoDir, "nano-servo-usb.world.lock.json"), { force: true });
  const nanoPlan = planWorld(nanoDir, "nano-servo-usb.world.json");
  if (!nanoPlan.ok) {
    throw new Error(nanoPlan.errors.map((item) => item.message).join("; "));
  }
  const nanoFeeds = powerFeedsOf(nanoPlan.plan);
  const nanoServo = await runProject(
    nanoDir,
    "nano-servo-usb.world.json",
    500,
    "nano"
  );
  const nanoServoPeak = nanoServo.frames.reduce(
    (max, frame) => Math.max(max, frame.parts.servo?.maxCurrent ?? 0),
    0
  );
  const amsPeak = nanoServo.frames.reduce(
    (max, frame) => Math.max(max, frame.boards.nano?.regulatorMax ?? 0),
    0
  );
  expect(
    nanoFeeds.parts.servo === "bench",
    `nano servo feed ${nanoFeeds.parts.servo}`
  );
  expect(amsPeak > nanoServoPeak && amsPeak < 1.5, `AMS ${amsPeak} A`);
  console.log(
    `nano servo on VIN 9 V: servo feed ${nanoFeeds.parts.servo}, servo peak ${nanoServoPeak.toFixed(4)} A, AMS1117 peak ${amsPeak.toFixed(4)} A (iLimit 1.5 A)`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  await stopWorld(root, "blink.world.json");
  closeRootWatches();
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-dual-supply-"));
  try {
    mkdirSync(join(dir, "parts", "sfab"), { recursive: true });
    cpSync(join(nanoExample, "firmware"), join(dir, "firmware"), {
      recursive: true,
    });
    const body = `{
      "format": "sfab.part@1",
      "id": "sfab/dual-scene@1.0.0",
      "type": "assembly",
      "foreign": false,
      "axes": {
        "behaviour": { "2": { "default": "netlist", "variants": { "netlist": {
          "kind": "composite", "omits": ["two supplies"],
          "netlist": {
            "instances": {
              "nano": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/hold/hold.hex", "source": "firmware/hold/hold.ino" } },
              "usb": { "part": "sfab/usb-port-500ma@1.0.0" },
              "vin": { "part": "sfab/bench-supply@1.0.0", "params": { "V": 9, "Ilimit": 2 } }
            },
            "wires": [
              ["usb.5V", "nano.5V"], ["usb.GND", "nano.GND"],
              ["vin.5V", "nano.VIN"], ["vin.GND", "nano.GND"]
            ],
            "expose": {}
          }
        } } } },
        "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } },
        "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } }
      }
    }`;
    writeFileSync(join(dir, "parts", "sfab", "dual-scene@1.0.0.json"), body);
    writeFileSync(
      join(dir, "dual.world.json"),
      `{
        "version": 2,
        "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
        "run": { "seed": 1, "levels": { "default": 1, "paths": { "nano": { "behaviour": 2 } } } },
        "root": { "id": "scene", "part": "sfab/dual-scene@1.0.0" }
      }`
    );
    const planned = planWorld(dir, "dual.world.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    const islands = powerIslands(planned.plan);
    const island = islands.find((item) => item.supplyIds.length > 1);
    expect(
      island,
      `islands ${islands.map((item) => item.supplyIds.join("+")).join(",")}`
    );
    const board = planned.plan.boards.find((item) => item.id === "nano");
    if (!board?.stamp?.vbusNode) throw new Error("dual nano has no stamp");
    const vinId = suppliesOnPort(planned.plan, "nano", "VIN")[0];
    const railId = suppliesOnPort(planned.plan, "nano", board.voltagePin)[0];
    const vin = planned.plan.supplies.find((item) => item.id === vinId);
    const usb = planned.plan.supplies.find((item) => item.id === railId);
    if (!vin || !usb || !board.stamp.vbusNode) throw new Error("dual supplies");
    const circuit = createRailCircuit({
      vNom: vin.voltage,
      rSeries: vin.rSeries,
      iLimit: vin.currentLimit,
      motors: [],
      pin: board.pin,
      ledAlias: "nano.led",
      stamp: board.stamp,
      feed: "vin",
      keep: [board.stamp.vbusNode],
      primaryId: vin.id,
      also: [
        {
          id: usb.id,
          vNom: usb.voltage,
          rSeries: usb.rSeries,
          iLimit: usb.currentLimit,
          node: board.stamp.vbusNode,
        },
      ],
    });
    circuit.setFixed(NANO_BOARD_A);
    circuit.solve();
    const pass = circuit.regulatorOut("nano");
    const s4 = circuit.diodeCurrent(".s4");
    if (s4 === null) throw new Error("dual rail has no S4");
    const hand = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
      boardId: "nano",
    });
    const vbus = hand.vbusNode;
    if (!vbus) throw new Error("hand stamp");
    const realized = realize(hand, "vin", AVR_PIN, { keep: [vbus] });
    const load = new CurrentLoad("load", realized.boardNode, "0", 0);
    load.amps = NANO_BOARD_A;
    const engine = new Engine(
      [
        new TheveninLimit("usb", vbus, "0", 5, 0.5, 0.9),
        new TheveninLimit("vin", realized.feedNode, "0", 9, 0.05, 2),
        load,
        ...realized.elements,
      ],
      { method: "be", h: 0.0001, atol: 1e-14, rtol: 1e-12 }
    );
    engine.operatingPoint();
    const handDiode = realized.elements.find(
      (el): el is Diode => el instanceof Diode && el.id.endsWith(".s4")
    );
    const handLdo = realized.elements.find(
      (el): el is LdoRegulator => el instanceof LdoRegulator
    );
    if (!handDiode || !handLdo) throw new Error("hand dual");
    const dPass = Math.abs(pass - engine.branchCurrent(handLdo.id));
    const dS4 = Math.abs(s4 - handDiode.amps);
    expect(dPass <= 1e-9, `regulator Δ ${dPass}`);
    expect(dS4 <= 1e-9, `S4 Δ ${dS4}`);
    console.log(
      `nano USB and VIN 9 V: regulator ${pass.toFixed(6)} A, S4 ${s4.toExponential(2)} A, regulator supplies the board`
    );
    const ran = await runProject(dir, "dual.world.json", 50, "nano");
    const reg = ran.frames.reduce(
      (max, frame) => Math.max(max, frame.boards.nano?.regulatorMax ?? 0),
      0
    );
    expect(reg > 0.02, `worker regulator ${reg}`);
    console.log(
      `nano USB and VIN world: regulator ${reg.toFixed(6)} A, plan island ${island?.supplyIds.join(" + ")}`
    );

    const unoBody = body
      .replaceAll("nano", "uno")
      .replaceAll("sfab/uno-ch340@1.0.0", "sfab/uno-r3@1.0.0")
      .replace("sfab/dual-scene@1.0.0", "sfab/uno-dual-scene@1.0.0");
    writeFileSync(
      join(dir, "parts", "sfab", "uno-dual-scene@1.0.0.json"),
      unoBody
    );
    writeFileSync(
      join(dir, "uno-dual.world.json"),
      `{
        "version": 2,
        "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
        "run": { "seed": 1, "levels": { "default": 1, "paths": { "uno": { "behaviour": 2 } } } },
        "root": { "id": "scene", "part": "sfab/uno-dual-scene@1.0.0" }
      }`
    );
    const unoPlanned = planWorld(dir, "uno-dual.world.json");
    if (!unoPlanned.ok) {
      throw new Error(unoPlanned.errors.map((item) => item.message).join("; "));
    }
    const unoBoard = unoPlanned.plan.boards.find((item) => item.id === "uno");
    const unoVinId = suppliesOnPort(unoPlanned.plan, "uno", "VIN")[0];
    const unoRailId = suppliesOnPort(
      unoPlanned.plan,
      "uno",
      unoBoard?.voltagePin ?? "5V"
    )[0];
    const unoVin = unoPlanned.plan.supplies.find(
      (item) => item.id === unoVinId
    );
    const unoUsb = unoPlanned.plan.supplies.find(
      (item) => item.id === unoRailId
    );
    if (!unoBoard?.stamp?.vbusNode || !unoVin || !unoUsb) {
      throw new Error("uno dual supplies");
    }
    const unoRail = createRailCircuit({
      vNom: unoVin.voltage,
      rSeries: unoVin.rSeries,
      iLimit: unoVin.currentLimit,
      motors: [],
      pin: unoBoard.pin,
      ledAlias: "uno.led",
      stamp: unoBoard.stamp,
      feed: "vin",
      keep: [unoBoard.stamp.vbusNode],
      primaryId: unoVin.id,
      also: [
        {
          id: unoUsb.id,
          vNom: unoUsb.voltage,
          rSeries: unoUsb.rSeries,
          iLimit: unoUsb.currentLimit,
          node: unoBoard.stamp.vbusNode,
        },
      ],
    });
    unoRail.setFixed(0.05);
    for (let i = 0; i < 3; i++) unoRail.solve();
    const unoPass = unoRail.regulatorOut("uno");
    const unoUsbA = unoRail.sourceCurrent(unoUsb.id);
    expect(unoRail.pmosOn() === false, "planned Uno T1 stayed on");
    expect(unoPass > 0.04, `planned Uno regulator ${unoPass}`);
    expect(Math.abs(unoUsbA) < 1e-3, `planned Uno USB ${unoUsbA}`);
    const unoRan = await runProject(dir, "uno-dual.world.json", 50, "uno");
    const unoReg = unoRan.frames.reduce(
      (max, frame) => Math.max(max, frame.boards.uno?.regulatorMax ?? 0),
      0
    );
    const liveUsb = unoRan.supplies?.usb?.current ?? Number.NaN;
    expect(unoReg > 0.04, `uno world regulator ${unoReg}`);
    expect(Math.abs(liveUsb) < 1e-3, `uno world USB ${liveUsb}`);
    console.log(
      `uno USB and VIN 9 V world: T1 off, NCP1117 ${unoReg.toFixed(6)} A, USB ${liveUsb.toExponential(2)} A`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const config = JSON.parse(
    readFileSync(join(catalogRoot(), "fixtures", "capture.config.json"), "utf8")
  ) as CaptureFile;
  const dir = mkdtempSync(join(tmpdir(), "vin-cap-"));
  try {
    for (const id of [
      "sfab/nano-power-input@1.0.0",
      "sfab/uno-power-input@1.0.0",
    ]) {
      const entry = config.entries.find((row) => row.id === id);
      if (!entry) throw new Error(`${id} capture entry`);
      const a = join(dir, "a.json");
      const b = join(dir, "b.json");
      const one = {
        created: config.created,
        tool: config.tool,
        entries: [entry],
      };
      await captureFromConfig({ config: one, outFile: a, freeRun: false });
      await captureFromConfig({ config: one, outFile: b, freeRun: false });
      const first = readFileSync(a, "utf8");
      const second = readFileSync(b, "utf8");
      expect(first === second, `${id} capture was not repeatable`);
      const catalog = readFileSync(
        join(catalogRoot(), "snapshots", `${id}.json`),
        "utf8"
      );
      expect(first === catalog, `${id} snapshot moved`);
      console.log(`capture ${id}: twice, byte-identical to the catalog`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
