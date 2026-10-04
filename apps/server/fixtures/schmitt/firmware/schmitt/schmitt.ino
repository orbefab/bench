// D9 drives 10 kOhm into 1 uF; D2 reads the capacitor node. Prints the
// microseconds from each D9 edge to the D2 edge that follows it.
void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT);
  pinMode(9, OUTPUT);
  digitalWrite(9, LOW);
  delay(100);
  Serial.print("start,");
  Serial.println(digitalRead(2));

  unsigned long t0 = micros();
  digitalWrite(9, HIGH);
  while (!digitalRead(2)) {}
  unsigned long rise = micros() - t0;

  while (micros() - t0 < 50000UL) {}
  unsigned long t1 = micros();
  digitalWrite(9, LOW);
  while (digitalRead(2)) {}
  unsigned long fall = micros() - t1;

  Serial.print("rise,");
  Serial.println(rise);
  Serial.print("fall,");
  Serial.println(fall);
}

void loop() {}
