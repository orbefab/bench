#include <avr/interrupt.h>

volatile uint8_t extra = 0;

ISR(TIMER2_COMPA_vect) {
  TIMSK2 = 0;
  if (!extra) return;
  extra = 0;
  digitalWrite(7, HIGH);
  delayMicroseconds(10);
  digitalWrite(7, LOW);
}

void trig(int highUs) {
  digitalWrite(7, LOW);
  delayMicroseconds(2);
  digitalWrite(7, HIGH);
  delayMicroseconds(highUs);
  digitalWrite(7, LOW);
}

// D7 is PD7. digitalWrite plus delayMicroseconds(8) leaves the pin high
// for more than 10 us, because the write itself is several microseconds,
// and the module then accepts it. The loop is 3 cycles per count at
// 16 MHz, so 40 counts is about 8 us between the two port writes.
void pulseShort() {
  uint8_t count = 40;
  PORTD |= _BV(PD7);
  __asm__ __volatile__(
    "1: dec %[count]\n\t"
    "brne 1b\n\t"
    : [count] "+r"(count)
  );
  PORTD &= ~_BV(PD7);
}

void setup() {
  Serial.begin(115200);
  pinMode(7, OUTPUT);
  pinMode(8, INPUT);

  pulseShort();
  long ignored = pulseIn(8, HIGH, 5000);
  Serial.print("short,");
  Serial.println(ignored);

  trig(10);
  long timeout = pulseIn(8, HIGH, 50000);
  Serial.print("timeout,");
  Serial.println(timeout);

  // A second trigger 1 ms after the falling edge, while Echo is still high.
  TCCR2A = _BV(WGM21);
  TCCR2B = _BV(CS22);
  OCR2A = 250;
  TCNT2 = 0;
  extra = 1;
  TIMSK2 = _BV(OCIE2A);
  trig(10);
  long again = pulseIn(8, HIGH, 50000);
  Serial.print("retrigger,");
  Serial.println(again);
  Serial.print("extra,");
  Serial.println(extra);
}

void loop() {}
