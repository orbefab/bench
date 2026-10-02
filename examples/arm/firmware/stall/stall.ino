#include <Servo.h>

// Commands 180 degrees. On the bench supply (5 V, 0.3 A) the first pulse
// pulls the rail to about 1.70 V, the board resets, holds 66 ms, and repeats.
// Each assert step torques the joint once; the open winding then coasts, so
// the arm walks a few degrees and does not reach the stop.
Servo s;

void setup() {
  Serial.begin(115200);
  Serial.println("boot");
  s.attach(9);
  s.write(180);
}

void loop() {}
