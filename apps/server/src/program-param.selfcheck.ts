/**
 * Programs and value sets as instance params (run 7 unit 5a-1): the strict
 * parser and its canonical form, the half-open sampler, the chirp against
 * the hinge fixture's formula, the PRBS register, the capture's cross runs,
 * an edit and its inverse, a session edit whose undo restores the bytes,
 * and a `$param` forward with its lint. A scratch project under the temp
 * dir; the catalog and examples stay put.
 */
import { deepEqual, equal, ok as expect } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  crossRuns,
  type Diagnostic,
  type EditOp,
  type NetlistInstance,
  type PartFile,
  type Program,
  parseProgram,
  parseStructured,
  parseValueSet,
  programDuration,
  sampleProgram,
  type ValueSet,
  type WorldViewNode,
} from "@sfab-bench/contract";
import {
  applyEdit,
  declaredQuantity,
  documentNetlist,
  EditSession,
  loadWorldV2,
  readEditOp,
  structuredDecl,
} from "@sfab-bench/parts";

import { viewOf } from "@sfab-bench/sim/view";
import { instanceCard } from "../../web/src/lib/world-card";
import { nodeStore } from "./world/node-store";
import { catalogRoot, planWorld } from "./world/plan";

function program(...variants: [string, Program["variants"][0]["segments"]][]) {
  return {
    kind: "program",
    use: variants[0]?.[0] ?? "a",
    variants: variants.map(([id, segments]) => ({ id, segments })),
  } satisfies Program;
}

function rejects(raw: unknown, pattern: RegExp, what: string): void {
  const parsed = parseStructured(raw);
  expect(!parsed.ok, `${what}: parsed`);
  if (!parsed.ok)
    expect(pattern.test(parsed.error), `${what}: ${parsed.error}`);
}

/** A program around segments the types would refuse, for the parser. */
function loose(...variants: [string, unknown[]][]): unknown {
  return {
    kind: "program",
    use: variants[0]?.[0] ?? "a",
    variants: variants.map(([id, segments]) => ({ id, segments })),
  };
}

// The parser: strict, and canonical in key order.
{
  const hold = { kind: "hold", dur: 1, level: 0 };
  rejects(
    { ...(loose(["a", [hold]]) as object), extra: 1 },
    /unknown key extra/,
    "a stray key"
  );
  rejects(
    loose(["a", [{ kind: "hold", dur: 1 }]]),
    /missing level/,
    "a missing field"
  );
  rejects(
    loose(["a", [{ ...hold, gain: 2 }]]),
    /unknown key gain/,
    "a field of another kind"
  );
  rejects(
    loose(["a", [{ ...hold, kind: "sine" }]]),
    /unknown kind sine/,
    "an unknown kind"
  );
  rejects(
    loose(["a", [{ ...hold, dur: 0 }]]),
    /dur must be at least 1 ns/,
    "zero duration"
  );
  rejects(
    loose(["a", [{ ...hold, dur: 1e-300 }]]),
    /dur must be at least 1 ns/,
    "a duration below the time resolution"
  );
  expect(
    parseProgram(loose(["a", [{ ...hold, dur: 1e-9 }]])).ok,
    "1 ns is a duration"
  );
  rejects(loose(["a", [{ ...hold, level: Number.NaN }]]), /finite/, "NaN");
  rejects(loose(["a", [{ ...hold, level: "1" }]]), /finite/, "a string level");
  const prbs = { kind: "prbs", dur: 1, seed: 1, period: 0.1, low: 0, high: 1 };
  rejects(
    loose(["a", [{ ...prbs, seed: 0 }]]),
    /seed must be/,
    "seed 0 locks the register"
  );
  rejects(
    loose(["a", [{ ...prbs, seed: 128 }]]),
    /seed must be/,
    "seed past 7 bits"
  );
  rejects(
    loose(["a", [{ ...prbs, seed: 1.5 }]]),
    /seed must be/,
    "a fractional seed"
  );
  rejects(
    loose(["a", [{ ...prbs, period: 0 }]]),
    /period must be at least 1 ns/,
    "zero period"
  );
  rejects(loose(["a", []]), /non-empty/, "no segments");
  rejects(
    { kind: "program", use: "a", variants: [] },
    /non-empty/,
    "no variants"
  );
  rejects(
    loose(["a", [hold]], ["a", [hold]]),
    /duplicate variant a/,
    "a duplicate id"
  );
  rejects(
    { ...(loose(["a", [hold]]) as object), use: "b" },
    /use b is no variant/,
    "use names no variant"
  );
  rejects(
    { kind: "values", use: 2, values: [1, 2] },
    /past the list/,
    "use past the list"
  );
  rejects({ kind: "values", use: 0, values: [] }, /non-empty/, "no values");
  rejects(
    { kind: "values", use: 0, values: [1, Number.POSITIVE_INFINITY] },
    /finite/,
    "an infinite value"
  );
  rejects({ kind: "values", use: -1, values: [1] }, /index/, "a negative use");
  rejects(
    { kind: "values", use: 0.5, values: [1, 2] },
    /index/,
    "a fractional use"
  );

  const shuffled = JSON.parse(
    '{"variants":[{"segments":[{"high":1,"low":0,"period":0.1,"seed":5,"dur":1,"kind":"prbs"}],"id":"a"}],"use":"a","kind":"program"}'
  );
  const parsed = parseProgram(shuffled);
  expect(parsed.ok, "a shuffled program parses");
  if (parsed.ok) {
    equal(
      JSON.stringify(parsed.value),
      '{"kind":"program","use":"a","variants":[{"id":"a","segments":[{"kind":"prbs","dur":1,"seed":5,"period":0.1,"low":0,"high":1}]}]}',
      "the parse is in canonical key order"
    );
  }
  const set = parseValueSet({ values: [2e-6, 5e-6], use: 1, kind: "values" });
  expect(set.ok, "a value set parses");
  if (set.ok)
    equal(
      JSON.stringify(set.value),
      '{"kind":"values","use":1,"values":[0.000002,0.000005]}'
    );
}

// Half-open segments: a boundary belongs to the segment that starts there;
// before 0 the first segment's start; from the end, the last's left limit.
{
  const steps = program([
    "a",
    [
      { kind: "hold", dur: 1, level: 1 },
      { kind: "step", dur: 1, level: 2 },
      { kind: "ramp", dur: 2, from: 0, to: 4 },
    ],
  ]);
  equal(programDuration(steps), 4);
  equal(sampleProgram(steps, -1), 1, "before 0");
  equal(sampleProgram(steps, 0), 1);
  equal(sampleProgram(steps, 0.999999), 1);
  equal(sampleProgram(steps, 1), 2, "the boundary is the next segment's");
  equal(sampleProgram(steps, 2), 0, "the ramp starts at its from");
  equal(sampleProgram(steps, 3), 2, "half way up the ramp");
  equal(sampleProgram(steps, 4), 4, "at the end: the ramp's left limit");
  equal(sampleProgram(steps, 99), 4, "past the end holds");
  const pair = [0.37, 1.2, 2.5, 3.99].map((t) => sampleProgram(steps, t));
  deepEqual(
    [0.37, 1.2, 2.5, 3.99].map((t) => sampleProgram(steps, t)),
    pair,
    "a second pass gives the same samples"
  );
}

// The chirp is the hinge fixture's: amp sin(2π (f0 t + (f1 - f0) t² / 2T)),
// from its own segment's start.
{
  const amp = 0.02;
  const f0 = 0.5;
  const f1 = 8;
  const T = 3;
  const lead = 0.25;
  const chirp = program([
    "a",
    [
      { kind: "hold", dur: lead, level: 0 },
      { kind: "chirp", dur: T, amp, f0, f1, phase: 0 },
    ],
  ]);
  let worst = 0;
  for (let k = 0; k < 600; k++) {
    const tau = (T * k) / 600;
    const fixture =
      amp *
      Math.sin(2 * Math.PI * (f0 * tau + ((f1 - f0) * tau * tau) / (2 * T)));
    worst = Math.max(
      worst,
      Math.abs(sampleProgram(chirp, lead + tau) - fixture)
    );
  }
  expect(worst < 1e-12, `the chirp matches the fixture formula: ${worst}`);
  const shifted = program([
    "a",
    [{ kind: "chirp", dur: T, amp, f0, f1, phase: Math.PI / 2 }],
  ]);
  expect(
    Math.abs(sampleProgram(shifted, 0) - amp) < 1e-15,
    "phase offsets the start"
  );
}

// PRBS: x^7 + x^6 + 1 from the seed, one bit per period, maximal length
// (127 bits, 64 ones), and the register restarts with its segment.
{
  const period = 0.01;
  const prbs = {
    kind: "prbs",
    dur: 2.54,
    seed: 37,
    period,
    low: -1,
    high: 1,
  } as const;
  const alone = program(["a", [prbs]]);
  const bits = (p: Program, from: number, n: number) =>
    Array.from({ length: n }, (_, k) =>
      sampleProgram(p, from + (k + 0.5) * period)
    );
  const first = bits(alone, 0, 127);
  equal(
    first.filter((v) => v === 1).length,
    64,
    "a maximal sequence has 64 ones"
  );
  deepEqual(bits(alone, 127 * period, 127), first, "it repeats after 127 bits");
  deepEqual(bits(alone, 0, 127), first, "the same seed gives the same bits");
  const other = bits(program(["a", [{ ...prbs, seed: 38 }]]), 0, 127);
  expect(
    JSON.stringify(other) !== JSON.stringify(first),
    "another seed differs"
  );
  const late = program(["a", [{ kind: "hold", dur: 0.333, level: 0 }, prbs]]);
  deepEqual(
    bits(late, 0.333, 127),
    first,
    "the register restarts at the segment"
  );
  const ragged = program(["a", [{ ...prbs, dur: 0.035 }]]);
  equal(
    sampleProgram(ragged, 0.035),
    sampleProgram(ragged, 0.034),
    "a partial last bit holds to the end"
  );

  // The bits themselves: pinned for seed 37, and the register's
  // recurrence (left-shifting taps 6 and 5 emit s[n+7] = s[n+1] ^ s[n]),
  // so another maximal register with 64 ones would fail here.
  equal(
    first
      .slice(0, 32)
      .map((v) => (v === 1 ? "1" : "0"))
      .join(""),
    "11011100110010101011111110000001",
    "seed 37's first 32 bits"
  );
  const s = [...first, ...first].map((v) => (v === 1 ? 1 : 0));
  for (let n = 0; n < 127; n++) {
    equal(s[n + 7], (s[n + 1] ?? 0) ^ (s[n] ?? 0), `recurrence at ${n}`);
  }
  // Sampled at its own edges, bit k is bit k: k * period is not always
  // the float the register divides back to k.
  deepEqual(
    Array.from({ length: 127 }, (_, k) => sampleProgram(alone, k * period)),
    first,
    "each bit from its own edge"
  );
  // At the end of exactly 127 bits the last bit holds, not bit 127 (= 0).
  const exact = program(["a", [{ ...prbs, dur: 1.27 }]]);
  equal(sampleProgram(exact, 1.27), first[126], "the end holds bit 126");
}

// Boundaries on a millisecond grid: the running sum of durations is not
// the grid, so 0.1 + 0.2 must still hand t = 0.3 to the next segment.
{
  const grid = (levels: [number, number][]) => {
    const p = program([
      "a",
      levels.map(([dur, level]) => ({ kind: "hold" as const, dur, level })),
    ]);
    const misses: string[] = [];
    let at = 0;
    for (const [dur, level] of levels) {
      const from = Math.round(at * 1000);
      const to = Math.round((at + dur) * 1000);
      for (let k = from; k < to; k++) {
        const got = sampleProgram(p, k * 0.001);
        if (got !== level) misses.push(`k=${k} got ${got} expect ${level}`);
      }
      at += dur;
    }
    return misses;
  };
  deepEqual(
    grid([
      [0.1, 1],
      [0.2, 2],
      [0.1, 9],
    ]),
    [],
    "100 + 200 + 100 ms"
  );
  deepEqual(
    grid(
      Array.from({ length: 20 }, (_, k) => [0.001, k] as [number, number])
    ),
    [],
    "twenty 1 ms holds"
  );
  const sum = program([
    "a",
    [
      { kind: "hold", dur: 0.1, level: 1 },
      { kind: "hold", dur: 0.2, level: 2 },
      { kind: "ramp", dur: 1, from: 5, to: 6 },
    ],
  ]);
  equal(sampleProgram(sum, 0.3), 5, "t = 0.3 starts the ramp");
  equal(sampleProgram(sum, 0.1 + 0.2), 5, "and so does the running sum");
}

// A capture runs every value against every variant, value-major.
{
  const hold = [{ kind: "hold", dur: 1, level: 0 }] as const;
  const seven = program(
    ...["a", "b", "c", "d", "e", "f", "g"].map(
      (id) => [id, [...hold]] as [string, Program["variants"][0]["segments"]]
    )
  );
  const values: ValueSet = { kind: "values", use: 0, values: [2e-6, 5e-6] };
  const runs = crossRuns(values, seven);
  equal(runs.length, 14);
  deepEqual(runs[0], { value: 2e-6, variant: "a" });
  deepEqual(runs[6], { value: 2e-6, variant: "g" });
  deepEqual(runs[7], { value: 5e-6, variant: "a" });
}

// A scratch project: a dynamometer part, a rig that forwards to it, worlds.
const dir = mkdtempSync(join(tmpdir(), "sfab-program-param-"));
mkdirSync(join(dir, "parts/sfab"), { recursive: true });
// The dynamometer's real type comes with its runtime (5a-2); a portless
// project type stands in.
mkdirSync(join(dir, "types"), { recursive: true });
writeFileSync(
  join(dir, "types/dynamometer.json"),
  `${JSON.stringify({ format: "sfab.part-type@1", id: "dynamometer", ports: {} })}\n`
);

function write(part: PartFile): string {
  const name = part.id.split("/")[1] ?? part.id;
  const file = join(dir, "parts/sfab", `${name}.json`);
  writeFileSync(file, `${JSON.stringify(part, null, 2)}\n`);
  return file;
}

function composite(
  id: string,
  instances: Record<string, NetlistInstance>,
  play = false
): PartFile {
  return {
    format: "sfab.part@1",
    id,
    type: "assembly",
    foreign: false,
    ...(play
      ? { play: { gravity: [0, 0, -9.81], seed: 1, levels: { default: 2 } } }
      : {}),
    axes: {
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: ["test composite"],
              netlist: { instances, wires: [], expose: {} },
            },
          },
        },
      },
    },
  } as PartFile;
}

const DYNO = "sfab/pp-dyno@1.0.0";
const dyno = {
  format: "sfab.part@1",
  id: DYNO,
  type: "dynamometer",
  foreign: false,
  axes: {
    behaviour: {
      "1": {
        default: "dyno",
        variants: {
          dyno: {
            kind: "form",
            form: "dynamometer@1",
            params: {},
            omits: ["test part"],
          },
        },
      },
    },
  },
} as unknown as PartFile;
write(dyno);

function load(file: string) {
  const loaded = loadWorldV2(file, {
    store: nodeStore,
    catalogDir: catalogRoot(),
    assetRoot: dir,
  });
  return {
    resolved: loaded.resolved,
    errors: loaded.diagnostics.filter((diag) => diag.severity === "error"),
  };
}

function said(errors: Diagnostic[]): string {
  return errors.map((diag) => `${diag.port}: ${diag.message}`).join(" | ");
}

const drive = program(
  ["slow", [{ kind: "ramp", dur: 2, from: 0, to: 0.05 }]],
  ["fast", [{ kind: "chirp", dur: 1, amp: 0.05, f0: 1, f1: 20, phase: 0 }]]
);
const inertia: ValueSet = { kind: "values", use: 0, values: [2e-6, 5e-6] };

try {
  // A bench sets the dynamometer's program and inertia on its instance.
  const benchFile = write(
    // Two instances, so the bench stays the stage (one child would run
    // as the stage itself).
    composite(
      "sfab/pp-bench@1.0.0",
      {
        dyno: { part: DYNO, params: { torque: drive, inertia } },
        spare: { part: DYNO },
      },
      true
    )
  );
  {
    const bench = load(benchFile);
    deepEqual(bench.errors, [], said(bench.errors));
    const inst = bench.resolved.find((row) => row.path === "dyno");
    deepEqual(
      inst?.params.torque,
      drive,
      `the program resolves whole: ${bench.resolved.map((row) => `${row.path}=${Object.keys(row.params)}`).join(" ")}`
    );
    deepEqual(inst?.params.inertia, inertia, "the value set resolves whole");
  }

  // Lint: one value on a program, the wrong kind, a broken program, and a
  // structured value on a param the part does not declare.
  {
    const file = write(
      composite(
        "sfab/pp-lint@1.0.0",
        {
          a: { part: DYNO, params: { torque: 0.1 } },
          b: { part: DYNO, params: { torque: inertia } },
          c: { part: DYNO, params: { torque: { ...drive, use: "none" } } },
          d: { part: DYNO, params: { gain: drive } },
        },
        true
      )
    );
    const lint = load(file).errors;
    const at = (port: string, pattern: RegExp) =>
      expect(
        lint.some((diag) => diag.port === port && pattern.test(diag.message)),
        `${port} ${pattern}: ${said(lint)}`
      );
    at("a.torque", /is a program, not one value/);
    at("b.torque", /is a program, not a value set/);
    at("c.torque", /use none is no variant/);
    at("d.gain", /does not declare/);
  }

  // A rig forwards `drive` to the dynamometer: the rig declares it with the
  // child's kind and quantity, and the value arrives whole.
  const rig = composite("sfab/pp-rig@1.0.0", {
    dyno: { part: DYNO, params: { torque: { $param: "drive" } } },
  });
  write(rig);
  const byId = new Map<string, PartFile>([
    [DYNO, dyno],
    [rig.id, rig],
  ]);
  const partById = (id: string) => byId.get(id) ?? null;
  deepEqual(structuredDecl(rig, "drive", partById), {
    kind: "program",
    quantity: "Torque",
  });
  equal(declaredQuantity(rig, "drive", partById), "program");
  {
    const file = write(
      composite(
        "sfab/pp-forward@1.0.0",
        { rig: { part: rig.id, params: { drive } } },
        true
      )
    );
    const forward = load(file);
    deepEqual(forward.errors, [], said(forward.errors));
    const child = forward.resolved.find((row) => row.path === "dyno");
    deepEqual(
      child?.params.torque,
      drive,
      `the forward arrives: ${forward.resolved.map((row) => row.path).join(",")}`
    );
  }
  {
    // A program forwarded into a value set, and one name fed to a program
    // and to a one-value param.
    const crossed = composite("sfab/pp-crossed@1.0.0", {
      one: { part: DYNO, params: { torque: { $param: "drive" } } },
      two: { part: DYNO, params: { inertia: { $param: "drive" } } },
      three: { part: DYNO, params: { torque: { $param: "plain" } } },
      four: { part: "sfab/led-red@1.0.0", params: { Rs: { $param: "plain" } } },
    });
    write(crossed);
    const file = write(
      composite(
        "sfab/pp-crossed-world@1.0.0",
        { x: { part: crossed.id } },
        true
      )
    );
    const lint = load(file).errors;
    expect(
      lint.some(
        (diag) =>
          diag.port === "two.inertia" &&
          /drive, a program, into a value set/.test(diag.message)
      ),
      `a program into a value set: ${said(lint)}`
    );
    expect(
      lint.some(
        (diag) =>
          diag.port === "four.Rs" &&
          /plain, a program, into a single value/.test(diag.message)
      ),
      `a program into one value: ${said(lint)}`
    );
  }

  // Edits: the op reads, stores the canonical form, and its inverse
  // restores; a structured value on a one-value param fails.
  {
    const ctx = {
      names: ["doc"],
      partById,
      portsOf: () => null,
      domainOf: () => null,
      quantityOf: (id: string, name: string) => {
        const part = partById(id);
        return part ? declaredQuantity(part, name, partById) : null;
      },
    };
    const start = composite("sfab/pp-edit@1.0.0", { dyno: { part: DYNO } });
    const read = readEditOp({
      kind: "set-param",
      document: "doc",
      id: "dyno",
      name: "torque",
      // Keys out of order: the edit stores the canonical form.
      value: { variants: drive.variants, use: drive.use, kind: "program" },
    });
    expect(!("error" in read), JSON.stringify(read));
    const bad = readEditOp({
      kind: "set-param",
      document: "doc",
      id: "dyno",
      name: "torque",
      value: { kind: "program", use: "a", variants: [] },
    });
    expect(
      "error" in bad && /^set-param: /.test(bad.error),
      JSON.stringify(bad)
    );
    const op = read as EditOp;
    const done = applyEdit(start, op, ctx);
    expect(!("error" in done), JSON.stringify(done));
    if (!("error" in done)) {
      deepEqual(
        documentNetlist(done.part)?.instances.dyno?.params?.torque,
        drive,
        "the stored program"
      );
      const back = applyEdit(done.part, done.inverse, ctx);
      expect(!("error" in back), JSON.stringify(back));
      if (!("error" in back))
        deepEqual(back.part, start, "the inverse restores");
    }
    const wrongKind = applyEdit(
      start,
      {
        kind: "set-param",
        document: "doc",
        id: "dyno",
        name: "inertia",
        value: drive,
      },
      ctx
    );
    expect("error" in wrongKind, "a program on a value-set param fails");
  }

  // add-instance takes programs in its params bag, canonical; a bag it
  // cannot read is an error, not a silent drop of its other values.
  {
    const added = readEditOp({
      kind: "add-instance",
      document: "doc",
      id: "d2",
      part: DYNO,
      params: {
        gain: 1,
        torque: { variants: drive.variants, use: drive.use, kind: "program" },
      },
    });
    expect(
      !("error" in added) && added.kind === "add-instance",
      JSON.stringify(added)
    );
    if (!("error" in added) && added.kind === "add-instance") {
      equal(added.params?.gain, 1, "the scalar beside it stays");
      equal(
        JSON.stringify(added.params?.torque),
        JSON.stringify(drive),
        "the program is canonical"
      );
    }
    const broken = readEditOp({
      kind: "add-instance",
      document: "doc",
      id: "d2",
      part: DYNO,
      params: { gain: 1, torque: { ...drive, use: "none" } },
    });
    expect(
      "error" in broken && /params\.torque: program: use none/.test(broken.error),
      JSON.stringify(broken)
    );
    const notBag = readEditOp({
      kind: "add-instance",
      document: "doc",
      id: "d2",
      part: DYNO,
      params: [1],
    });
    expect("error" in notBag, "params that are not an object");
  }

  // A forward the parent does not set: the child records the forward, so
  // the card leaves it to the parent, and the rig's card offers the program.
  {
    const rel = "parts/sfab/pp-unset@1.0.0.json";
    write(
      composite(
        "sfab/pp-unset@1.0.0",
        { rig: { part: rig.id }, spare: { part: DYNO } },
        true
      )
    );
    const planned = planWorld(dir, rel);
    if (!planned.ok) {
      throw new Error(planned.errors.map((row) => row.message).join("; "));
    }
    const view = viewOf(planned.plan);
    const flat = (nodes: readonly WorldViewNode[]): WorldViewNode[] =>
      nodes.flatMap((node) => [node, ...flat(node.children)]);
    const nodes = flat(view.tree.nodes);
    const rigNode = nodes.find((node) => node.id === "rig");
    const child = nodes.find((node) => node.id === "rig.dyno");
    deepEqual(
      rigNode?.structured,
      { drive: { kind: "program", quantity: "Torque" } },
      `the rig declares drive: ${nodes.map((node) => node.id).join(",")}`
    );
    deepEqual(child?.forwards?.torque, { from: "rig", param: "drive" });
    const rigCard = rigNode ? instanceCard(rigNode).structured : [];
    deepEqual(
      rigCard.map((row) => [row.name, row.value, row.forward ?? null]),
      [["drive", null, null]],
      "the rig card offers Set program"
    );
    const childCard = child ? instanceCard(child).structured : [];
    const torque = childCard.find((row) => row.name === "torque");
    expect(
      torque?.value === null && torque.forward?.param === "drive",
      `the child row is the parent's: ${JSON.stringify(torque)}`
    );
  }

  // A session edit writes the file and its undo restores the bytes.
  {
    const rel = "parts/sfab/pp-bench@1.0.0.json";
    const before = readFileSync(benchFile, "utf8");
    const opened = EditSession.open({
      file: benchFile,
      names: [rel, benchFile],
      store: nodeStore,
      catalogDir: catalogRoot(),
      assetRoot: dir,
    });
    if ("error" in opened) throw new Error(opened.error);
    const next = { ...drive, use: "fast" };
    const edited = opened.apply({
      kind: "set-param",
      document: rel,
      id: "dyno",
      name: "torque",
      value: next,
    });
    expect(
      !("error" in edited) && !("needsConfirm" in edited),
      JSON.stringify(edited)
    );
    const written = JSON.parse(readFileSync(benchFile, "utf8")) as PartFile;
    deepEqual(
      documentNetlist(written)?.instances.dyno?.params?.torque,
      next,
      "the file holds the edit"
    );
    const undone = opened.undo();
    expect(!("error" in undone), JSON.stringify(undone));
    equal(readFileSync(benchFile, "utf8"), before, "undo restores the bytes");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("program-param.selfcheck ok");
