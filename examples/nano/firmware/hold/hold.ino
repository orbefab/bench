#include <Servo.h>
Servo s;
const int targets[] = {10, 90, 120};
void setup() {
  Serial.begin(115200);
  s.attach(9);
}
void loop() {
  for (int i = 0; i < 3; i++) {
    s.write(targets[i]);
    Serial.println(targets[i]);
    delay(1000);
  }
}
