#include <Servo.h>

Servo flag;
int angle = 0;
int reading = 0;

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
  pinMode(13, OUTPUT);
  pinMode(7, OUTPUT);
  pinMode(8, INPUT);
  flag.attach(9);
  flag.write(angle);
  Serial.println("boot");
}

void loop() {
  static unsigned long next = 0;
  unsigned long now = millis();
  if ((long)(now - next) < 0) return;
  next = now + 60;

  digitalWrite(7, LOW);
  delayMicroseconds(2);
  digitalWrite(7, HIGH);
  delayMicroseconds(10);
  digitalWrite(7, LOW);
  long us = pulseIn(8, HIGH, 30000);

  if (us > 0) {
    float d = us / 58.0;
    long cm = (long)d;
    if (cm < 2) cm = 2;
    if (cm > 100) cm = 100;
    angle = (int)map(cm, 2, 100, 0, 180);
    digitalWrite(13, d < 15.0 ? HIGH : LOW);
    Serial.print(us);
    Serial.print(',');
    Serial.print(d);
    Serial.print(',');
    Serial.println(angle);
  } else {
    digitalWrite(13, LOW);
    Serial.print(us);
    Serial.print(',');
    Serial.print(-1);
    Serial.print(',');
    Serial.println(angle);
  }

  flag.write(angle);
  reading += 1;
  if (reading % 10 == 0) {
    Serial.print("vcc,");
    Serial.println(readVcc());
  }
}
