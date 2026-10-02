void setup() {
  Serial.begin(115200);
  pinMode(7, OUTPUT);
  pinMode(8, INPUT);
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
  if (us > 0) Serial.println(us);
  else Serial.println(-1);
}
