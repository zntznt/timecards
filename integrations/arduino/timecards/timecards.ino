// timecards — Arduino sketch (button + status LED + optional PN532 NFC).
//
// The Arduino is the SENSOR; a host computer runs the bridge (host/bridge.js) that
// maps these serial events to timecards CLI commands and pushes state back. This
// sketch reimplements no timer logic — it just reports input and shows state.
//
//   Button tap        -> "PRESS\n"   (host: timecards press)
//   Button hold 1.5s  -> "HOLD\n"    (host: timecards stop)
//   NFC tag tapped    -> "NFC:04A2B1C3\n"  (host: timecards slot --nfc 04:A2:B1:C3)
//   Host -> Arduino   "LED:running|solid|slow|off\n"  drives the status LED
//
// Wiring + setup: see ../README.md. NFC is optional — if no PN532 is found the
// sketch still runs the button + LED (it does not halt).

#include <Wire.h>
#include <Adafruit_PN532.h>

// ── pins ──
const uint8_t BTN_PIN = 7;     // momentary button to GND (uses INPUT_PULLUP)
const uint8_t LED_PIN = 13;    // status LED (through a resistor to GND)
#define PN532_IRQ   2
#define PN532_RESET 3
Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET, &Wire);
bool nfcReady = false;

// ── button: debounce + tap vs hold (millis-based, no delay) ──
const unsigned long DEBOUNCE_MS = 25;
const unsigned long HOLD_MS = 1500;
int btnStable = HIGH, btnLastRead = HIGH;
unsigned long btnLastChange = 0, pressStart = 0;
bool holdFired = false;

// ── LED: non-blocking patterns ──
enum LedMode { LED_OFF, LED_SOLID, LED_SLOW, LED_FAST };
LedMode ledMode = LED_SLOW;
unsigned long ledLast = 0;
bool ledOn = false;

void setLed(LedMode m) { ledMode = m; }

void updateLed() {
  unsigned long now = millis();
  switch (ledMode) {
    case LED_OFF:   digitalWrite(LED_PIN, LOW);  return;
    case LED_SOLID: digitalWrite(LED_PIN, HIGH); return;
    case LED_SLOW:  if (now - ledLast >= 500) { ledLast = now; ledOn = !ledOn; digitalWrite(LED_PIN, ledOn); } return;
    case LED_FAST:  if (now - ledLast >= 120) { ledLast = now; ledOn = !ledOn; digitalWrite(LED_PIN, ledOn); } return;
  }
}

void updateButton() {
  unsigned long now = millis();
  int raw = digitalRead(BTN_PIN);
  if (raw != btnLastRead) { btnLastChange = now; btnLastRead = raw; }
  if (now - btnLastChange >= DEBOUNCE_MS && raw != btnStable) {
    btnStable = raw;
    if (btnStable == LOW) { pressStart = now; holdFired = false; }  // pressed
    else if (!holdFired) Serial.println("PRESS");                   // released before hold = tap
  }
  if (btnStable == LOW && !holdFired && now - pressStart >= HOLD_MS) {
    holdFired = true;
    Serial.println("HOLD");
  }
}

void handleLine(const String& line) {
  if (line.startsWith("LED:")) {
    String v = line.substring(4);
    if      (v == "running")  setLed(LED_SOLID);   // running -> steady on
    else if (v == "paused")   setLed(LED_SLOW);    // paused  -> slow blink
    else if (v == "finished") setLed(LED_FAST);    // alarm   -> fast blink
    else if (v == "ready")    setLed(LED_SLOW);
    else if (v == "solid")    setLed(LED_SOLID);
    else if (v == "slow")     setLed(LED_SLOW);
    else if (v == "fast")     setLed(LED_FAST);
    else                       setLed(LED_OFF);    // empty/off
  }
}

void pollSerial() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();                                   // drop trailing \r / spaces
    if (line.length()) handleLine(line);
  }
}

// ── NFC: emit "NFC:<UPPERCASE HEX>" on a new tag ──
uint8_t lastUid[7]; uint8_t lastUidLen = 0; unsigned long lastNfcMs = 0;

void pollNfc() {
  if (!nfcReady) return;
  uint8_t uid[7]; uint8_t uidLen = 0;
  if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 50)) {
    bool same = (uidLen == lastUidLen) && memcmp(uid, lastUid, uidLen) == 0;
    if (!same || millis() - lastNfcMs > 1000) {
      Serial.print("NFC:");
      for (uint8_t i = 0; i < uidLen; i++) {
        if (uid[i] < 0x10) Serial.print('0');
        Serial.print(uid[i], HEX);                 // host uppercases + colon-joins
      }
      Serial.println();
      memcpy(lastUid, uid, uidLen); lastUidLen = uidLen; lastNfcMs = millis();
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(20);
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  nfc.begin();
  if (nfc.getFirmwareVersion()) { nfc.SAMConfig(); nfcReady = true; }
  // No PN532? Carry on button-only (don't halt).
  Serial.println("READY");
}

void loop() {
  updateButton();
  updateLed();
  pollSerial();
  pollNfc();
}
