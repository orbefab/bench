#include <Servo.h>

Servo servo;
int angle = 10;

// Bandgap against AVCC. 1.1 * 1023 * 1000, integer division.
long readVcc() {
  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);
  delay(2);
  ADCSRA |= _BV(ADSC);
  while (bit_is_set(ADCSRA, ADSC)) {
  }
  uint8_t low = ADCL;
  uint8_t high = ADCH;
  long count = ((long)high << 8) | low;
  return 1125300L / count;
}

void setup() {
  Serial.begin(115200);
  servo.attach(9);
  servo.write(angle);
}

void loop() {
  static unsigned long lastVcc = 0;
  static unsigned long lastSweep = 0;
  unsigned long now = millis();
  if (now - lastVcc >= 100) {
    lastVcc = now;
    Serial.print("vcc,");
    Serial.println(readVcc());
  }
  if (now - lastSweep >= 1000) {
    lastSweep = now;
    angle = angle == 10 ? 170 : 10;
    servo.write(angle);
  }
}
