# Generic boards and capture from the card (sharpen, 2026-09-29)

Working notes from the owner's sharpen of R5 (generic boards) and A6
(capture from the card). Not authoritative: the ADRs, `manual.md` and
`formats.md` change with the units that build this, and this note is
deleted once they do.

## Vocabulary

- **Chip part:** a part whose type is an MCU die (`atmega328p`,
  `atmega32u4`). Its ports are the chip's own pins (`PB5`, `PC0`, `VCC`,
  `GND`, `RESET`, …). Its firmware level carries the image, the fuses, the
  brownout and the pin drivers.
- **Board composite:** a dev board (`nano-ch340`, `uno-r3`, `pro-micro`)
  as a composite of parts: the chip, power input, LEDs, reset network and
  USB-serial bridge. Header ports expose onto chip pins (`D13 → mcu.PB5`),
  so the expose table is the pin map.
- **Chip registry:** code in `engine-mcu`, keyed by chip type. It holds only
  what the emulator knows: core, clock, SRAM, peripherals, and which
  emulator runs the chip. Electrical facts live in the chip part's data.
- **Capture recipe:** the part type's `capture` field (fixture, form,
  settings). It replaces `catalog/fixtures/capture.config.json`, and it is
  ADR 0012's "capture recipe" seam.
- **Level overlay:** `overlays/<pub>/<name>@<ver>.levels.json` in a
  project. It adds captured levels to every instance of a library part
  without writing the library file (ADR 0011).

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| R5-1 | How generic is "generic"? | Boards are data, and the seams leave room for a second chip: a general pin-state format replaces the 20-bit Arduino mask, and a chip registry selects the emulator. |
| R5-2 | What proves it? | A real second board, the Pro Micro (ATmega32U4, 5 V, 16 MHz), on avr8js. A spike comes first. ESP8266 and ESP32 are out: there is no permissively licensed JS emulator for them. |
| R5-3 | Where do facts live? | Board facts in part documents and types, chip emulator facts in the `engine-mcu` registry. The web and agent tools read both from the server. |
| R5-4 | Chip versus board | The chip is its own part, and a dev board is a composite of parts. The firmware variant's `board` netlist, `boardCircuit` and `path:uno-usb` go away. |
| R5-5 | Which boards convert? | All three: Uno, Nano and Pro Micro. The Uno and Nano examples must replay their old recordings identically. |
| A6-1 | What is a fixture? | Split in two. A6a: Capture on the card runs the part type's existing fixture. A6b: a fixture tool that builds a test-bench scene around a part, sharpened after A6a. |
| A6-2 | Where does a capture land? | `<project>/snapshots/<pub>/<name>@<ver>.json`, which the loader already resolves (project, then personal library, then catalog). A project part gains a level; a library part gets a level overlay. The lock pins both. |
| A6-3 | After a capture | The part stays on its current level. The toast offers the new capture, and one click switches to it as an undoable edit. |
| Order | Landing order | R4, then A6a, then R7, then R5 (chip and board split, generic pin state, Pro Micro), then R6. |

## Contradictions found, and how they resolve

- **ADR 0012 says a second MCU core can be added, but the code is
  ATmega328P-only** (`chipFacts`, `ARDUINO_PINS`, `CPU_HZ`). R5 adds the chip
  registry and the generic pin-state format.
- **A part file said the chip's pin drivers stay in the board's firmware
  params.** With the chip as its own part, they move to the chip part.
- **The manual and ADR 0011 say a capture is a snapshot "beside the part",
  but snapshot refs are ids resolved from `snapshots/`.** The docs change to
  "in the project's snapshots folder".
- **The card should name each level's source, but the level-card helper is
  unused.** A6a revives it.
- **Freshness reads variant and instance from the catalog capture config.**
  Provenance records them instead, once the recipe moves to the part type.
- **The manual's fixture is a scene you build, but the code's fixture is a
  `sfab.fixture@1` file.** Both stay: A6a uses the file, and A6b builds the
  scene.

## Non-goals

- ESP8266 and ESP32 emulation, and the RP2040.
- Compiling inside Bench (ADR 0009 stands).
- Moving the catalog CLI capture's output.
- A port rename UI.
- Capturing visuals.
