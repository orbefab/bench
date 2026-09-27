# Circuit reference traces

ngspice 45.2, inside `eecircuit-engine` 1.8.0. The decks use gear,
`temp=25`, `tnom=25`, `gmin=1e-12`, and a max step equal to the engine
step. The run header was `Command: ngspice-45.2, Build Sat Sep  5 01:00:10 UTC 2026`.

Generator: `scratch/layered-sim/port-circuit-ref` @
`f6492d67f0bcd3526b8726311a9a2d070f2e6830`.

```bash
cd /abs/path/port-circuit-ref
npm install
npx tsx generate.ts /abs/path/apps/server/fixtures/circuit
```

`npm install` links E1's already-installed `eecircuit-engine`
(`file:../e1/node_modules/eecircuit-engine`). That package is not a
dependency of sfab-bench.

Transient files are a `.cir` deck and a CSV of time (s) and the probe
(V), at most 2000 points, SI. The pot files are the mid-scale deck
(α = 0.5). The JSON sweep uses the same topology with the two divider
resistors changed, and records wiper and rail voltage (V).

| Id | Probe | Step | Stop |
| --- | --- | --- | --- |
| rc-step | out | 1 µs | 4 ms |
| divider | mid | 10 µs | 200 µs |
| diode-clamp | out | 1 µs | 2 ms |
| pin-led | a | 1 µs | 50 µs |
| pwm-50 | out | 10 µs | 80 ms |
| pwm-20 | out | 10 µs | 80 ms |
| nano-power | rail | 100 ns | 3 ms |
| uno-usb | v5 | 20 ns | 3 ms |
| nano-usb | v5 | 20 ns | 3 ms |
| nano-d13 | d13 | 20 ns | 3 ms |
| pot-adc-50 | wiper, rail | DC | 5.0 V rail |
| pot-adc-44 | wiper, rail | DC | 4.4 V rail |
