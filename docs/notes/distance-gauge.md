# Distance gauge

The owner builds this device for real. Bench runs it as `examples/gauge/gauge-usb.world.json`. The CAD is `examples/gauge/cad/`. The firmware is `examples/gauge/firmware/gauge/gauge.ino`, the same file for the real Nano and for Bench.

Values marked **verify** come from memory of common datasheets. Check them against the actual part and its datasheet before any number goes into the catalog.

## 1. What it does

- A fixed HC-SR04 measures the distance to whatever is in front of it, for example a hand or a card.
- The servo turns a printed flag over a printed dial, pointing at that distance.
- The Nano's own LED (D13) lights when something is close.
- Each reading is printed over serial.

In Bench the thing that moves is a target in the scene. `gauge-usb.world.json` moves the card on `path`: 50 cm, then 10 cm at 1 s, 90 cm at 2.5 s, 30 cm at 4 s, then out of the beam at 5.5 s. Each step is two keyframes 1 ms apart, so the card jumps and the servo slews. `world_move_target` can place it during a run. Dragging it in the view is later.

## 2. Parts

| Ref | Part | Notes |
| --- | --- | --- |
| U1 | Arduino Nano clone (ATmega328P, 16 MHz, CH340 USB) | Catalog `sfab/nano-ch340@1.0.0`. Its power path and D13 LED are modelled from photos of the board, not from the official schematic |
| M1 | TowerPro MG90S micro servo (metal gears) | Catalog `sfab/mg90s@1.0.0`, fitted from its datasheet and the measurements below |
| S1 | HC-SR04 ultrasonic module | Catalog `sfab/hc-sr04@1.0.0`. 5 V, 15 mA working, 40 kHz, 2–400 cm, 15° measuring angle, 10 µs trigger, echo width ∝ distance (the sheet's 58 µs/cm) |
| — | Female-female Dupont wires, USB cable for the Nano | Note the cable length |
| — | Printed parts: base (holds the Nano, sensor and servo), flag on the servo horn, dial behind the flag (0–100 cm marks) | `examples/gauge/cad/` |

## 3. Wiring

| From | To |
| --- | --- |
| USB (PC) | Nano USB port (the only power source) |
| Nano 5V | servo V+ (red), HC-SR04 VCC |
| Nano GND | servo GND (brown), HC-SR04 GND |
| Nano D9 | servo signal (orange); Servo library, Timer1 |
| Nano D7 | HC-SR04 Trig |
| Nano D8 | HC-SR04 Echo; read with `pulseIn` |

Everything is on the Nano's 5 V node, so the servo's current sags the sensor's supply.

## 4. Firmware behaviour (`gauge.ino`)

- **Setup:** `Serial.begin(115200)`, print `boot`, attach the servo to D9, write the held angle, and set D13 as an output.
- **Every 60 ms:**
  - **Ping:** Trig LOW 2 µs, HIGH 10 µs, LOW. Then `pulseIn(8, HIGH, 30000)`; 0 means no echo. `d = us / 58.0` cm.
  - **Servo:** on an echo, set the angle to `map(clamp(d, 2, 100), 2, 100, 0, 180)` and `write` it. With no echo, `write` the last angle again.
  - **LED:** D13 on if there is an echo and `d < 15` cm.
  - **Output:** print `us,d_cm,angle`, with `d_cm = -1` for no echo.
- **Supply line:** every 10th reading, print `vcc,<mV>`, measured by reading the internal 1.1 V bandgap against AVCC (the usual `readVcc` method). Calibrate it once against the Fluke at idle. It logs the 5 V dips while the servo moves.

## 5. Level map

Classes follow D-004: 0 ideal, 1 behavioural, 2 structural (its children), 3 physical (offline only). **Check** is what each level is held against.

| Part | Axis | 0 | 1 | 2 | 3 | Check |
| --- | --- | --- | --- | --- | --- | --- |
| Nano board | behaviour | ideal 5 V node, no draw | constant board current | the clone's circuits: USB diode, +5V caps, D13 LED and its resistor, reset network; chip on its pins | — | ngspice; M1, M2, M9 |
| Nano chip | behaviour | scripted pins | sketch compiled natively against a host HAL | avr8js, cycle-exact | — | firmware output |
| USB supply | behaviour | ideal 5 V | `thevenin-limit@1` | PC port + cable R | — | M1, M2 |
| MG90S | behaviour | ideal position | class-1 law (voltage-mode motor, E_sat) | control IC + motor (+L) + pot | — | datasheet; M2, M6 |
| MG90S | body | massless hinge | lumped hinge with armature and friction, plus the flag | metal gear train | meshes (offline capture source) | M5, M6 |
| HC-SR04 | behaviour | exact distance on one ray | datasheet: beam cone, 2–400 cm, echo timing, timeout, 15 mA | incidence angle, multipath, speed of sound vs temperature | acoustic simulation (offline) | M3, M4, M8 |
| Base, flag, dial | body | — | rigid bodies from CAD | — | — | slicer mass |

The gauge world asks for class 1, and for the Nano's behaviour at class 2 (circuits, chip in avr8js). The MG90S and the HC-SR04 run at class 1. The printed bodies are class 1.

## 6. Measurement sheet (owner)

**Kit now:**

- the Fluke 15B+;
- a phone with slow-motion video;
- a tape measure;
- a flat cardboard target (about 30 × 30 cm) and a thin pole (a pencil on a stand);
- a printed protractor.

The firmware's serial log does the timing work. A logic analyzer (for braking and pulse timing) may come later.

**Current with the Fluke:** move the red lead to the A jack and put the meter **in series**, either in the servo's red wire or between the Nano's 5V pin and the wires it feeds. Only steady values are meaningful: idle, holding, stalled.

**Every session:** write down the room temperature, the PC and USB port, the cable length, and the markings on the Nano (the chips next to the USB connector).

| # | What | How | Feeds |
| --- | --- | --- | --- |
| M1 | Nano 5V voltage: idle, holding, servo stalled (hold the flag about 2 s) | Fluke on 5V–GND for steady values; the `vcc` line for dips while moving | Nano class 2 |
| M2 | Current: idle, holding, stalled, in the servo wire and in the Nano's 5V feed | Fluke in series. The stalled servo-wire reading is the MG90S stall current the fit needs | USB supply, MG90S |
| M3 | Echo time vs distance: flat target square-on at 5, 10, 20, 50, 100, 200 cm; 20 readings each | serial `us` column | HC-SR04 class 1. Also times the delay from Trig's fall to Echo's rise |
| M4 | Beam width: pole at 50 cm moved sideways; the angle where echoes stop, each side. Also the echo-high time with nothing in range | printed protractor under the sensor; serial `us` with no target | HC-SR04 class 1 |
| M5 | Gauge accuracy: flag angle against the dial at 10, 30, 60, 90 cm, approached from near and from far | photo of the flag and dial; the near/far difference shows backlash | MG90S body |
| M6 | Servo step response: move the target quickly from 10 cm to 90 cm and back | 240 fps video of the flag; frames to 10–90% | MG90S class 1, armature |
| M8 | Noise, idle current, and the voltage where the module stops echoing: 100 readings at 50 cm with the servo still, then with it moving | serial log; Fluke in series at idle | HC-SR04 supply |
| M9 | D13 LED current | Fluke on the voltage across the LED's resistor on the board (if reachable) | Nano class 2 |
| M10 | Masses | slicer filament mass for printed parts; datasheet for the servo (MG90S about 13.4 g, **verify**) and sensor | bodies. The URDF masses are assumed until this |

**Later (needs a scope):** M7, braking current.

Return: the numbers in a copy of this table, plus the raw serial logs and videos. The raw files stay with the measurements and are not committed as binaries.

## 7. Board

- Clone markings: **ATmega328P-AU, date code 1712** (TQFP-32, the chip avr8js runs); **CH340G** USB bridge; **AMS1117-5.0** regulator (only used when powered from VIN; on USB it sits on the 5 V net unpowered).
- HC-SR04 header: the four pins point **down**, in the plane of the board, past its bottom edge (the common module). The CAD models it that way.
- A part near the USB connector marked **C106**. Most likely a tantalum capacitor, 10 µF / 16 V ("106" = 10 µF, "C" = 16 V; on a tantalum the stripe is +), not the diode. To confirm: colour and size, or the Fluke diode test (a capacitor reads OL).
- **USB diode marked `S4`**. This is most commonly an SS14-type Schottky (1 A, 40 V) in SOD-123FL. Its forward drop is higher than the official Nano's MBR0520: up to about 0.5 V at 1 A. The catalog law follows the SS14 datasheet (**verify**). The Fluke diode test (about 0.2–0.35 V) confirms that it is a Schottky; M1 gives the drop under load.
- Still missing (optional): the D13 LED's resistor code.
