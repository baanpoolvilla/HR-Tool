#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <Adafruit_Fingerprint.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>
#include <time.h>
#include <esp_task_wdt.h>

#define WDT_TIMEOUT 25  // auto-restart ถ้าค้างเกิน 25 วินาที

// ===== LCD 16x2 (I2C / PCF8574) =====
#define LCD_COLS 16
#define LCD_ROWS 2
LiquidCrystal_I2C* lcd = nullptr;   // สร้างหลังสแกนหา address จริง
uint8_t lcdAddr = 0x27;
bool lcdReady = false;

// ===== FINGERPRINT =====
#define FP_RX 16
#define FP_TX 17
HardwareSerial fpSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&fpSerial);

// ===== BUZZER PWM (Passive Buzzer) =====
#define BUZZER_PIN 25

void tone(int freq, int duration) {
  ledcAttach(BUZZER_PIN, freq, 8);
  ledcWrite(BUZZER_PIN, 128);
  delay(duration);
  ledcWrite(BUZZER_PIN, 0);
  ledcDetach(BUZZER_PIN);
  delay(20);
}

void beepOK()       { tone(1000,100); tone(1500,150); }
void beepFail()     { tone(500,400); }
void beepEnroll()   { tone(800,80); tone(1000,80); tone(1400,200); }
void beepNotFound() { tone(400,800); }
void beepStart()    { tone(600,80); tone(900,80); tone(1200,150); }

// ===== LED ตัวสแกนนิ้ว =====
void setFingerLED(bool on) {
  if (on) finger.LEDcontrol(FINGERPRINT_LED_ON,  0, FINGERPRINT_LED_BLUE);
  else    finger.LEDcontrol(FINGERPRINT_LED_OFF, 0, FINGERPRINT_LED_BLUE);
}

// ===== Config =====
#define DEFAULT_SERVER_URL "https://attendance.poolvillapattayaparty.com"
#define DEFAULT_DEVICE_ID  "OFFICE"

// ===== WiFi หลัก — ต่อตัวนี้ก่อนเสมอ ถ้าไม่ติดค่อยเปิด FP-Setup portal =====
#define WIFI_SSID "Office_2.4GHz"
#define WIFI_PASS "123456789"

// ===== Device key — ต้องตรงกับ DEVICE_API_KEY บนเซิร์ฟเวอร์ =====
#define DEVICE_KEY "CHANGE_ME_DEVICE_KEY"

String SERVER_URL = DEFAULT_SERVER_URL;
String DEVICE_ID  = DEFAULT_DEVICE_ID;

Preferences prefs;

// ===== NTP =====
const char* ntpServer   = "pool.ntp.org";
const long  gmtOffset   = 25200;
const int   daylightOffset = 0;

unsigned long lastWifiCheck    = 0;
unsigned long lastSensorReinit = 0;
int consecutiveScanFails       = 0;

volatile bool clockEnabled = true;  // false = ห้าม clock task วาดทับ
SemaphoreHandle_t lcdMutex = NULL;  // ป้องกัน Core 0 / Core 1 เขียน I2C พร้อมกัน

// ===== งานจากเว็บ: netTask (Core 0) ตั้งค่า flag → loop (Core 1) ลงมือทำ =====
// แยก network polling ออกจากลูปสแกน เพื่อให้ "วางนิ้วแล้วสแกนทันที" ไม่โดน HTTP บล็อก
volatile int  pendingEnrollId    = -1;    // >=0 = มีคำสั่ง enroll รอทำ
volatile bool pendingSensorClear = false; // true = มีคำสั่งล้างเซนเซอร์รอทำ
volatile bool sensorBusy         = false; // true = core1 กำลังใช้เซนเซอร์ (enroll/clear) → core0 หยุด poll
SemaphoreHandle_t netMutex = NULL;  // serialize HTTP ข้าม 2 core (GET บน core0 / POST บน core1)

// ===== เวลา =====
String getTimeStr() {
  struct tm t;
  if (!getLocalTime(&t)) return "--:--:--";
  char buf[10];
  strftime(buf, sizeof(buf), "%H:%M:%S", &t);
  return String(buf);
}

// ===== LCD helper — เขียนทั้งบรรทัด เติมช่องว่างจนเต็ม 16 ตัว =====
// (ไม่ใช้ lcd->clear() เพื่อลดอาการจอกระพริบ)
void lcdRow(uint8_t row, String s) {
  if (!lcdReady || !lcd) return;
  if ((int)s.length() > LCD_COLS) s = s.substring(0, LCD_COLS);
  while ((int)s.length() < LCD_COLS) s += ' ';
  lcd->setCursor(0, row);
  lcd->print(s);
}

// ===== หน้าจอหลัก (clock task เรียกทุก 1 วินาที) =====
void showMain() {
  if (!lcdReady || !lcdMutex) return;
  // ถ้า Core 1 กำลังใช้จออยู่ → ข้ามเฟรมนี้แทนที่จะรอ
  if (xSemaphoreTake(lcdMutex, pdMS_TO_TICKS(100)) != pdTRUE) return;

  struct tm t;
  char l0[20];
  if (getLocalTime(&t)) {
    const char* months[] = {"Jan","Feb","Mar","Apr","May","Jun",
                            "Jul","Aug","Sep","Oct","Nov","Dec"};
    snprintf(l0, sizeof(l0), "%2d %s %02d:%02d:%02d",
             t.tm_mday, months[t.tm_mon], t.tm_hour, t.tm_min, t.tm_sec);
  } else {
    snprintf(l0, sizeof(l0), "   --:--:--");
  }
  lcdRow(0, l0);
  lcdRow(1, WiFi.status() == WL_CONNECTED ? "Place finger..." : "**  NO WIFI  **");

  xSemaphoreGive(lcdMutex);
}

// ===== ข้อความทั่วไป — ใช้ 2 บรรทัด (l3/inv เก็บไว้เพื่อ compat แต่ไม่ใช้บนจอ 16x2) =====
void showMsg(String l1, String l2 = "", String l3 = "", bool inv = false) {
  if (!lcdReady || !lcdMutex) return;
  xSemaphoreTake(lcdMutex, portMAX_DELAY);
  lcdRow(0, l1);
  lcdRow(1, l2.length() ? l2 : l3);
  xSemaphoreGive(lcdMutex);
}

// ===== หน้าเช็คอิน/เช็คเอาท์ =====
void showCheckin(String name, int id, String checkType, bool isLate = false) {
  if (!lcdReady || !lcdMutex) return;
  xSemaphoreTake(lcdMutex, portMAX_DELAY);
  String tag = (checkType == "OUT") ? "OUT" : (isLate ? "LATE" : "IN");
  lcdRow(0, tag + " " + name);                        // เช่น "IN John Smith"
  lcdRow(1, getTimeStr() + " ID:" + String(id));      // เช่น "11:22:33 ID:5"
  xSemaphoreGive(lcdMutex);
}

// ===== หน้าลงทะเบียนนิ้ว =====
void showEnroll(int id, int step, String msg) {
  if (!lcdReady || !lcdMutex) return;
  xSemaphoreTake(lcdMutex, portMAX_DELAY);
  char l0[20];
  snprintf(l0, sizeof(l0), "Enroll #%d  %d/2", id, step);  // "Enroll #5  1/2"
  lcdRow(0, l0);
  lcdRow(1, msg);
  xSemaphoreGive(lcdMutex);
}

// ===== หน้าไม่พบนิ้ว =====
void showNotFound() {
  if (!lcdReady || !lcdMutex) return;
  xSemaphoreTake(lcdMutex, portMAX_DELAY);
  lcdRow(0, "NOT REGISTERED");
  lcdRow(1, "Contact admin");
  xSemaphoreGive(lcdMutex);
}

// ===== HTTP helper พร้อม timeout + netMutex (กันชนกันข้าม 2 core) =====
bool httpPost(String url, String body, String &respOut) {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (netMutex) xSemaphoreTake(netMutex, portMAX_DELAY);
  HTTPClient http;
  http.begin(url);
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code = http.POST(body);
  bool ok = (code == 200 || code == 201);
  if (ok) respOut = http.getString();
  http.end();
  if (netMutex) xSemaphoreGive(netMutex);
  return ok;
}

bool httpGet(String url, String &respOut) {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (netMutex) xSemaphoreTake(netMutex, portMAX_DELAY);
  HTTPClient http;
  http.begin(url);
  http.setTimeout(2500);
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code = http.GET();
  bool ok = (code == 200);
  if (ok) respOut = http.getString();
  http.end();
  if (netMutex) xSemaphoreGive(netMutex);
  return ok;
}

// ===== ส่งข้อมูลเข้างาน =====
void sendAttendance(int fingerId) {
  if (WiFi.status() != WL_CONNECTED) {
    clockEnabled = false;
    showMsg("No Internet!", "Cannot record", "");
    return;
  }
  String resp;
  String body = "{\"device_id\":\"" + DEVICE_ID + "\",\"finger_id\":" + String(fingerId) + "}";
  // HTTP รันขณะ clockEnabled=true → นาฬิกาอัปเดตบน Core 0 ไปพร้อมกัน
  bool ok = httpPost(SERVER_URL + "/api/attendance", body, resp);
  if (!ok) {
    clockEnabled = false;
    showMsg("Server Error!", "Try again", "");
    return;
  }

  // Parse ชื่อ (ใช้ร่วมกันทุก case)
  String name = "Unknown";
  int ni = resp.indexOf("\"name\":\"");
  if (ni >= 0) { int s = ni+8; name = resp.substring(s, resp.indexOf("\"",s)); }

  // สแกนซ้ำ — มาแล้ว (IN zone)
  if (resp.indexOf("\"already_in\"") >= 0) {
    String hhmm = "";
    int hi = resp.indexOf("\"check_time_hhmm\":\"");
    if (hi >= 0) { int s = hi+19; hhmm = resp.substring(s, resp.indexOf("\"",s)); }
    clockEnabled = false;
    showMsg(name, "IN: " + hhmm + " (dup)", "");
    return;
  }

  // สแกนซ้ำ — OUT แล้ว
  if (resp.indexOf("\"already_out\"") >= 0) {
    clockEnabled = false;
    showMsg(name, "IN & OUT done", "");
    return;
  }

  // สำเร็จ — parse check_type และ is_late
  String checkType = "IN";
  int ci = resp.indexOf("\"check_type\":\"");
  if (ci >= 0) { int s = ci+14; checkType = resp.substring(s, resp.indexOf("\"",s)); }

  bool isLate = resp.indexOf("\"is_late\":true") >= 0;

  clockEnabled = false;
  showCheckin(name, fingerId, checkType, isLate);
}

// ===== แจ้ง Enroll สำเร็จ =====
void notifyEnrollDone(int id) {
  String resp;
  httpPost(SERVER_URL + "/api/enroll-complete",
           "{\"finger_id\":" + String(id) + ",\"confidence\":50}",
           resp);
}

// ===== ลงทะเบียนนิ้ว =====
bool enrollFinger(int id) {
  clockEnabled = false;
  showEnroll(id, 1, "Place finger");
  delay(1000);

  int r, tries = 0;
  while ((r = finger.getImage()) != FINGERPRINT_OK) {
    esp_task_wdt_reset();
    if (tries++ > 100) {
      showMsg("Timeout!", "Try again", "");
      beepFail();
      clockEnabled = true;
      return false;
    }
    delay(200);
  }
  if (finger.image2Tz(1) != FINGERPRINT_OK) {
    beepFail(); clockEnabled = true; return false;
  }

  showEnroll(id, 1, "Remove finger..");
  beepOK();
  delay(1500);
  while (finger.getImage() != FINGERPRINT_NOFINGER) {
    esp_task_wdt_reset();
    delay(200);
  }

  showEnroll(id, 2, "Place again");
  delay(1000);

  tries = 0;
  while ((r = finger.getImage()) != FINGERPRINT_OK) {
    esp_task_wdt_reset();
    if (tries++ > 100) { beepFail(); clockEnabled = true; return false; }
    delay(200);
  }
  if (finger.image2Tz(2) != FINGERPRINT_OK)  { beepFail(); clockEnabled = true; return false; }
  if (finger.createModel() != FINGERPRINT_OK) { beepFail(); clockEnabled = true; return false; }
  if (finger.storeModel(id) != FINGERPRINT_OK){ beepFail(); clockEnabled = true; return false; }

  showMsg("ENROLL OK!", "ID:" + String(id) + " saved", "", true);
  beepEnroll();
  notifyEnrollDone(id);
  finger.getTemplateCount();
  clockEnabled = true;
  return true;
}

// ===== Poll คำสั่ง enroll (รันบน Core 0 — GET อย่างเดียว ไม่แตะเซนเซอร์) =====
void pollEnrollCmd() {
  String resp;
  if (!httpGet(SERVER_URL + "/api/enroll-pending", resp)) return;
  if (resp.indexOf("\"pending\":true") >= 0) {
    int idx = resp.indexOf("\"finger_id\":");
    if (idx >= 0) pendingEnrollId = resp.substring(idx + 12).toInt();
  }
}

// ===== ทำ enroll จริง (รันบน Core 1 ใน loop — แตะเซนเซอร์ที่ core เดียว) =====
void runEnroll(int fid) {
  sensorBusy   = true;
  clockEnabled = false;
  showMsg("Web: Enroll", "ID:" + String(fid) + " ready...", "");
  delay(1500);
  enrollFinger(fid);  // enrollFinger จัดการ clockEnabled เอง
  delay(2000);
  clockEnabled = true;
  sensorBusy   = false;
}

// ===== Poll คำสั่งล้างเซนเซอร์ (รันบน Core 0 — GET อย่างเดียว) =====
void pollSensorClearCmd() {
  String resp;
  if (!httpGet(SERVER_URL + "/api/sensor-clear-pending", resp)) return;
  if (resp.indexOf("\"pending\":true") >= 0) pendingSensorClear = true;
}

// ===== ล้างเซนเซอร์จริง (รันบน Core 1 ใน loop) =====
void doSensorClear() {
  sensorBusy   = true;
  clockEnabled = false;
  showMsg("Clearing sensor", "Please wait...", "");
  uint8_t r = finger.emptyDatabase();
  if (r == FINGERPRINT_OK) {
    finger.getTemplateCount();
    showMsg("SENSOR CLEARED", "Re-enroll needed", "", true);
    beepEnroll();
  } else {
    showMsg("Clear FAILED!", "Error: " + String(r), "");
    beepFail();
  }
  delay(3000);
  clockEnabled = true;
  sensorBusy   = false;
}

// ===== WiFi Reconnect =====
void checkWifi() {
  if (millis() - lastWifiCheck < 60000) return;
  lastWifiCheck = millis();
  if (WiFi.status() == WL_CONNECTED) return;

  clockEnabled = false;
  showMsg("WiFi Lost!", "Reconnecting...", "");
  WiFi.reconnect();
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) {
    esp_task_wdt_reset();
    delay(500);
  }

  if (WiFi.status() != WL_CONNECTED) {
    showMsg("WiFi Failed!", "Restarting...", "");
    delay(2000);
    ESP.restart();
  }
  // re-sync NTP หลัง reconnect
  configTime(gmtOffset, daylightOffset, ntpServer);
  showMsg("WiFi OK!", WiFi.localIP().toString(), DEVICE_ID);
  delay(1000);
  clockEnabled = true;
}

// ===== Reinit sensor — แก้ UART stuck หลัง idle นาน =====
void reinitSensor() {
  fpSerial.end();
  delay(300);
  fpSerial.begin(57600, SERIAL_8N1, FP_RX, FP_TX);
  delay(300);
  finger.begin(57600);
  finger.verifyPassword();
  finger.getTemplateCount();
  while (fpSerial.available()) fpSerial.read(); // flush buffer
  consecutiveScanFails = 0;
  lastSensorReinit     = millis();
}

// ===== แสกนนิ้ว =====
int scanFinger() {
  // flush stale UART data ก่อนทุกครั้ง
  while (fpSerial.available()) fpSerial.read();

  uint8_t img = finger.getImage();
  if (img == FINGERPRINT_NOFINGER) { consecutiveScanFails = 0; return -1; }
  if (img != FINGERPRINT_OK)       { consecutiveScanFails++; return -1; }

  consecutiveScanFails = 0;
  setFingerLED(true);
  if (finger.image2Tz()     != FINGERPRINT_OK) { setFingerLED(false); return -1; }
  if (finger.fingerSearch() != FINGERPRINT_OK) { setFingerLED(false); return -2; }
  setFingerLED(false);
  return finger.fingerID;
}

// ===== Clock Task (Core 0) — อัปเดตนาฬิกาทุก 1 วินาที แม้ HTTP กำลัง block =====
void clockTaskFunc(void *param) {
  for (;;) {
    if (clockEnabled) showMain();
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

// ===== Network Task (Core 0) — poll คำสั่งเว็บทุก 3 วินาที =====
// รันแยกจาก loop() บน Core 1 → HTTP ที่บล็อกจะไม่หน่วงการสแกนนิ้วอีกต่อไป
void netTaskFunc(void *param) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED && !sensorBusy) {
      pollEnrollCmd();
      pollSensorClearCmd();
    }
    vTaskDelay(pdMS_TO_TICKS(3000));
  }
}

// ===== สแกนหา I2C address ของจอ LCD (PCF8574 มักเป็น 0x27 หรือ 0x3F) =====
uint8_t findLcdAddr() {
  const uint8_t candidates[] = {0x27, 0x3F, 0x20, 0x38, 0x26, 0x3E};
  for (uint8_t a : candidates) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) return a;
  }
  return 0x27;  // default เผื่อสแกนไม่เจอ
}

// ===== SETUP =====
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);

  Wire.begin(21, 22);
  lcdAddr  = findLcdAddr();
  lcd      = new LiquidCrystal_I2C(lcdAddr, LCD_COLS, LCD_ROWS);
  lcd->init();
  lcd->backlight();
  lcdReady = true;
  Serial.printf("LCD I2C addr = 0x%02X\n", lcdAddr);

  showMsg("Attendance Sys", "v6.1 realtime..", "");
  delay(1000);

  fpSerial.begin(57600, SERIAL_8N1, FP_RX, FP_TX);
  finger.begin(57600);
  if (!finger.verifyPassword()) {
    showMsg("ERROR!", "Check FP wiring", "");
    while (true) delay(1000);
  }
  finger.getTemplateCount();
  setFingerLED(false);
  showMsg("Fingerprint OK", "Count: " + String(finger.templateCount), "");
  delay(800);

  // ===== โหลด config จาก flash =====
  prefs.begin("atd", false);
  SERVER_URL = prefs.getString("server_url", DEFAULT_SERVER_URL);
  DEVICE_ID  = prefs.getString("device_id",  DEFAULT_DEVICE_ID);

  // Migration: ถ้ายังเป็น "Main" (ค่าเก่า) ให้อัปเป็น OFFICE
  if (DEVICE_ID == "Main") {
    DEVICE_ID = DEFAULT_DEVICE_ID;
    prefs.putString("device_id", DEVICE_ID);
  }
  prefs.end();

  // ===== ต่อ WiFi หลักก่อน =====
  showMsg("Connecting WiFi", WIFI_SSID, "");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    delay(250);
  }

  // ===== ต่อไม่ติด → เปิด WiFiManager portal ให้ตั้งค่าเอง =====
  if (WiFi.status() != WL_CONNECTED) {
    WiFiManager wm;
    WiFiManagerParameter p_server("server", "Server URL", SERVER_URL.c_str(), 80);
    WiFiManagerParameter p_device("device", "Device ID (branch)", DEVICE_ID.c_str(), 20);
    wm.addParameter(&p_server);
    wm.addParameter(&p_device);

    showMsg("Connect WiFi", "or join FP-Setup", "");
    wm.setConfigPortalTimeout(120);
    wm.setSaveParamsCallback([&]() {
      prefs.begin("atd", false);
      prefs.putString("server_url", String(p_server.getValue()));
      prefs.putString("device_id",  String(p_device.getValue()));
      prefs.end();
      SERVER_URL = String(p_server.getValue());
      DEVICE_ID  = String(p_device.getValue());
    });

    if (!wm.startConfigPortal("FP-Setup", "12345678")) {
      showMsg("WiFi Failed!", "Restarting...", "");
      delay(2000);
      ESP.restart();
    }
  }

  // ===== Sync NTP =====
  showMsg("Syncing time...", "pool.ntp.org", "");
  configTime(gmtOffset, daylightOffset, ntpServer);
  struct tm timeinfo;
  int ntpTry = 0;
  while (!getLocalTime(&timeinfo) && ntpTry < 20) { delay(500); ntpTry++; }
  if (ntpTry >= 20) { showMsg("Time sync fail", "Check internet", ""); delay(2000); }

  showMsg("WiFi OK!", WiFi.localIP().toString(), "ID: " + DEVICE_ID);
  beepStart();
  delay(1500);

  // สร้าง mutex ก่อนเริ่ม task — ป้องกัน I2C race และ HTTP ชนกันระหว่าง Core 0/1
  lcdMutex = xSemaphoreCreateMutex();
  netMutex = xSemaphoreCreateMutex();

  // เริ่ม Clock Task บน Core 0
  xTaskCreatePinnedToCore(clockTaskFunc, "clock", 4096, NULL, 1, NULL, 0);
  // เริ่ม Network Task บน Core 0 — poll คำสั่งเว็บแยกจากลูปสแกน (stack ใหญ่รองรับ TLS/HTTPS)
  xTaskCreatePinnedToCore(netTaskFunc, "net", 16384, NULL, 1, NULL, 0);

  // เปิด Hardware Watchdog — reset อัตโนมัติถ้าค้างเกิน 25s
  esp_task_wdt_config_t wdt_cfg = {
    .timeout_ms    = WDT_TIMEOUT * 1000,
    .idle_core_mask = 0,
    .trigger_panic  = true,
  };
  esp_task_wdt_deinit();
  esp_task_wdt_init(&wdt_cfg);
  esp_task_wdt_add(NULL);
}

// ===== LOOP =====
void loop() {
  esp_task_wdt_reset();  // บอก watchdog ว่ายังทำงานปกติ

  // WiFi reconnect ทุก 60s (คืนค่าเร็วถ้ายังไม่ถึงเวลา/ยังต่ออยู่)
  checkWifi();

  // คำสั่งจากเว็บ (netTask บน Core 0 ตั้ง flag ให้) — ทำบน Core 1 เพื่อใช้เซนเซอร์ที่ core เดียว
  if (pendingSensorClear) { pendingSensorClear = false; doSensorClear(); return; }
  if (pendingEnrollId >= 0) { int fid = pendingEnrollId; pendingEnrollId = -1; runEnroll(fid); return; }

  // Reinit sensor ทุก 10 นาที เพื่อล้าง UART state สะสม
  if (millis() - lastSensorReinit > 600000UL) reinitSensor();
  // Reinit เมื่อ error ต่อเนื่องผิดปกติ (sensor ค้าง)
  if (consecutiveScanFails > 20) reinitSensor();

  // ===== สแกนนิ้ว — ทำทุกลูป ไม่มี HTTP มาบล็อกอีกแล้ว → วางนิ้วปุ๊บ ติดปั๊บ =====
  int id = scanFinger();
  if (id > 0) {
    beepOK();
    sendAttendance(id);   // POST (ผ่าน netMutex) เกิดหลังสแกนติด — ผู้ใช้ได้ยิน beep ทันที
    delay(3000);
    clockEnabled = true;  // re-enable clock task to take over
  } else if (id == -2) {
    clockEnabled = false;
    beepNotFound();
    showNotFound();
    delay(2500);
    clockEnabled = true;
  }

  delay(20);   // ลูปถี่ขึ้น (เดิม 100ms) → ตรวจจับนิ้วไวขึ้น
}
