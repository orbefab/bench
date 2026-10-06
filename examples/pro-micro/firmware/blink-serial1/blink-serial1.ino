// RX LED (PB0, Arduino pin 17) on for 200 ms, then off for 200 ms.
// Each time it turns on, print a tick on Serial1 (USART1, pins PD3/PD2).
//
//   arduino-cli compile --fqbn arduino:avr:leonardo --output-dir <dir>
//   arduino-cli 1.5.1
//   arduino:avr core 1.8.8
void setup() {
  pinMode(17, OUTPUT);
  Serial1.begin(9600);
}

void loop() {
  digitalWrite(17, LOW);
  Serial1.println("tick");
  delay(200);
  digitalWrite(17, HIGH);
  delay(200);
}
