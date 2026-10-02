// D9 steady HIGH. PB1 on the ATmega328P. No PWM in this tree drives the module.
void setup() {
  pinMode(9, OUTPUT);
  digitalWrite(9, HIGH);
}

void loop() {}
