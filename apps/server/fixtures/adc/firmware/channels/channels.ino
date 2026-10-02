void setup() {
  Serial.begin(115200);
  pinMode(A2, OUTPUT);
  digitalWrite(A2, HIGH);
  pinMode(A3, INPUT_PULLUP);
  delay(10);

  int gnd = analogRead(A0);
  int v5 = analogRead(A1);
  int high = analogRead(A2);
  int pull = analogRead(A3);

  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);
  delay(2);
  ADCSRA |= _BV(ADSC);
  while (bit_is_set(ADCSRA, ADSC)) {
  }
  int bg = ADCL | (ADCH << 8);

  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1) | _BV(MUX0);
  delay(2);
  ADCSRA |= _BV(ADSC);
  while (bit_is_set(ADCSRA, ADSC)) {
  }
  int z = ADCL | (ADCH << 8);

  analogReference(INTERNAL);
  delay(2);
  int iref = analogRead(A1);

  Serial.print("gnd,");
  Serial.println(gnd);
  Serial.print("v5,");
  Serial.println(v5);
  Serial.print("high,");
  Serial.println(high);
  Serial.print("pull,");
  Serial.println(pull);
  Serial.print("bg,");
  Serial.println(bg);
  Serial.print("z,");
  Serial.println(z);
  Serial.print("iref,");
  Serial.println(iref);
  Serial.println("done");
}

void loop() {}
