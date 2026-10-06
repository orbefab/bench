// D9 PWM into an RC. PB1, Timer1 phase-correct 8-bit, prescale 64:
// 2 * 64 * 255 / 16 MHz = 2.04 ms period, high for 128 / 255 of it.
void setup() {
  pinMode(9, OUTPUT);
}

void loop() {
  analogWrite(9, 128);
}
