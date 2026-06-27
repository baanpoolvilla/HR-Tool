#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <Adafruit_Fingerprint.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Preferences.h>
#include <time.h>
#include <esp_task_wdt.h>

#define WDT_TIMEOUT 25  // auto-restart ถ้าค้างเกิน 25 วินาที

// ===== OLED =====
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
bool oledOK = false;

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

String SERVER_URL = DEFAULT_SERVER_URL;
String DEVICE_ID  = DEFAULT_DEVICE_ID;

Preferences prefs;

// ===== NTP =====
const char* ntpServer   = "pool.ntp.org";
const long  gmtOffset   = 25200;
const int   daylightOffset = 0;

unsigned long lastPoll      = 0;
unsigned long lastClock     = 0;
unsigned long lastWifiCheck = 0;

// ===== เวลา =====
String getTimeStr() {
  struct tm t;
  if (!getLocalTime(&t)) return "--:--:--";
  char buf[10];
  strftime(buf, sizeof(buf), "%H:%M:%S", &t);
  return String(buf);
}

String getDateStr() {
  struct tm t;
  if (!getLocalTime(&t)) return "";
  const char* days[]   = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};
  const char* months[] = {"Jan","Feb","Mar","Apr","May","Jun",
                           "Jul","Aug","Sep","Oct","Nov","Dec"};
  char buf[24];
  sprintf(buf, "%s %d %s %d", days[t.tm_wday], t.tm_mday, months[t.tm_mon], t.tm_year+1900);
  return String(buf);
}

// ===== หน้าจอ =====
void showMain() {
  if (!oledOK) return;
  display.clearDisplay();
  display.fillRect(0, 0, 128, 13, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(15, 3);
  display.print("ATTENDANCE SYSTEM");
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 16);
  display.print(getDateStr());
  display.setTextSize(2);
  String t = getTimeStr();
  int tw = t.length() * 12;
  display.setCursor((128 - tw) / 2, 27);
  display.print(t);
  display.drawLine(0, 49, 128, 49, SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 53);
  display.print("Place finger...");
  // WiFi indicator
  display.fillCircle(122, 56, 3,
    WiFi.status() == WL_CONNECTED ? SSD1306_WHITE : SSD1306_BLACK);
  if (WiFi.status() != WL_CONNECTED)
    display.drawCircle(122, 56, 3, SSD1306_WHITE);
  display.display();
}

void showMsg(String l1, String l2 = "", String l3 = "", bool inv = false) {
  if (!oledOK) return;
  display.clearDisplay();
  if (inv) { display.fillRect(0,0,128,64,SSD1306_WHITE); display.setTextColor(SSD1306_BLACK); }
  else display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0,  4); display.println(l1);
  display.setCursor(0, 24); display.println(l2);
  display.setCursor(0, 44); display.println(l3);
  display.display();
}

void showCheckin(String name, int id) {
  if (!oledOK) return;
  display.clearDisplay();
  display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(22, 3);
  display.print("CHECK-IN OK!");
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 18);
  display.print("Name: ");
  if (name.length() > 12) name = name.substring(0, 12) + "..";
  display.print(name);
  display.setCursor(0, 30);
  display.print("ID: "); display.print(id);
  display.setCursor(0, 44);
  display.print(getTimeStr());
  display.setCursor(0, 54);
  display.print(getDateStr());
  display.display();
}

void showEnroll(int id, int step, String msg) {
  if (!oledOK) return;
  display.clearDisplay();
  display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(2, 3);
  display.print("ENROLL ID: "); display.print(id);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(30, 18);
  display.print(step == 1 ? "[1] --> 2" : " 1  --> [2]");
  display.setTextSize(2);
  display.setCursor(55, 28);
  display.print(step == 1 ? "UP" : "OK");
  display.setTextSize(1);
  display.setCursor(0, 52);
  display.print(msg);
  display.display();
}

void showNotFound() {
  if (!oledOK) return;
  display.clearDisplay();
  display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(16, 3);
  display.print("NOT REGISTERED");
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(30, 20);
  display.print("UNKN");
  display.setTextSize(1);
  display.setCursor(0, 44);
  display.print("Finger not found");
  display.setCursor(0, 54);
  display.print("Contact admin");
  display.display();
}

// ===== HTTP helper พร้อม timeout =====
bool httpPost(String url, String body, String &respOut) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.begin(url);
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  bool ok = (code == 200 || code == 201);
  if (ok) respOut = http.getString();
  http.end();
  return ok;
}

bool httpGet(String url, String &respOut) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.begin(url);
  http.setTimeout(8000);
  int code = http.GET();
  bool ok = (code == 200);
  if (ok) respOut = http.getString();
  http.end();
  return ok;
}

// ===== ส่งข้อมูลเข้างาน =====
void sendAttendance(int fingerId) {
  if (WiFi.status() != WL_CONNECTED) {
    showMsg("No Internet!", "Cannot record", "");
    return;
  }
  String resp;
  String body = "{\"device_id\":\"" + DEVICE_ID + "\",\"finger_id\":" + String(fingerId) + "}";
  httpPost(SERVER_URL + "/api/attendance", body, resp);

  String name = "Unknown";
  int ni = resp.indexOf("\"name\":\"");
  if (ni >= 0) { int s = ni+8; name = resp.substring(s, resp.indexOf("\"",s)); }
  showCheckin(name, fingerId);
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
  showEnroll(id, 1, "Place finger");
  delay(1000);

  int r, tries = 0;
  while ((r = finger.getImage()) != FINGERPRINT_OK) {
    if (tries++ > 150) { showMsg("Timeout!", "Try again", ""); beepFail(); return false; }
    delay(200);
  }
  if (finger.image2Tz(1) != FINGERPRINT_OK) { beepFail(); return false; }

  showEnroll(id, 1, "Remove finger...");
  beepOK();
  delay(1500);
  while (finger.getImage() != FINGERPRINT_NOFINGER) delay(200);

  showEnroll(id, 2, "Place same finger");
  delay(1000);

  tries = 0;
  while ((r = finger.getImage()) != FINGERPRINT_OK) {
    if (tries++ > 150) { beepFail(); return false; }
    delay(200);
  }
  if (finger.image2Tz(2) != FINGERPRINT_OK)  { beepFail(); return false; }
  if (finger.createModel() != FINGERPRINT_OK) { beepFail(); return false; }
  if (finger.storeModel(id) != FINGERPRINT_OK){ beepFail(); return false; }

  showMsg("ENROLL OK!", "ID: " + String(id), "Registered!", true);
  beepEnroll();
  notifyEnrollDone(id);
  finger.getTemplateCount();
  return true;
}

// ===== Poll คำสั่งจากเว็บ =====
void checkEnrollCmd() {
  String resp;
  if (!httpGet(SERVER_URL + "/api/enroll-pending", resp)) return;
  if (resp.indexOf("\"pending\":true") >= 0) {
    int idx = resp.indexOf("\"finger_id\":");
    if (idx >= 0) {
      int fid = resp.substring(idx + 12).toInt();
      showMsg("Web Command:", "Enroll ID: " + String(fid), "Get ready...");
      delay(1500);
      enrollFinger(fid);
      delay(2000);
    }
  }
}

// ===== Poll คำสั่งล้างเซนเซอร์ =====
void checkSensorClearCmd() {
  String resp;
  if (!httpGet(SERVER_URL + "/api/sensor-clear-pending", resp)) return;
  if (resp.indexOf("\"pending\":true") >= 0) {
    showMsg("Clearing...", "Sensor memory", "Please wait");
    uint8_t r = finger.emptyDatabase();
    if (r == FINGERPRINT_OK) {
      finger.getTemplateCount();
      showMsg("SENSOR CLEARED", "Count: 0", "Re-enroll needed", true);
      beepEnroll();
    } else {
      showMsg("Clear FAILED!", "Error: " + String(r), "");
      beepFail();
    }
    delay(3000);
  }
}

// ===== WiFi Reconnect =====
void checkWifi() {
  if (millis() - lastWifiCheck < 60000) return;
  lastWifiCheck = millis();
  if (WiFi.status() == WL_CONNECTED) return;

  showMsg("WiFi Lost!", "Reconnecting...", "");
  WiFi.reconnect();
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) delay(500);

  if (WiFi.status() != WL_CONNECTED) {
    showMsg("WiFi Failed!", "Restarting...", "");
    delay(2000);
    ESP.restart();
  }
  // re-sync NTP หลัง reconnect
  configTime(gmtOffset, daylightOffset, ntpServer);
  showMsg("WiFi OK!", WiFi.localIP().toString(), DEVICE_ID);
  delay(1000);
}

// ===== แสกนนิ้ว =====
int scanFinger() {
  setFingerLED(false);
  if (finger.getImage() != FINGERPRINT_OK) return -1;
  setFingerLED(true);
  if (finger.image2Tz()     != FINGERPRINT_OK) { setFingerLED(false); return -1; }
  if (finger.fingerSearch() != FINGERPRINT_OK) { setFingerLED(false); return -2; }
  setFingerLED(false);
  return finger.fingerID;
}

// ===== SETUP =====
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);

  Wire.begin(21, 22);
  oledOK = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOK) oledOK = display.begin(SSD1306_SWITCHCAPVCC, 0x3D);

  showMsg("Attendance", "System v5.1", "Starting...");
  delay(1000);

  fpSerial.begin(57600, SERIAL_8N1, FP_RX, FP_TX);
  finger.begin(57600);
  if (!finger.verifyPassword()) {
    showMsg("ERROR!", "Check wiring", "Fingerprint");
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

  // ===== WiFiManager =====
  WiFiManager wm;
  WiFiManagerParameter p_server("server", "Server URL", SERVER_URL.c_str(), 80);
  WiFiManagerParameter p_device("device", "Device ID (branch)", DEVICE_ID.c_str(), 20);
  wm.addParameter(&p_server);
  wm.addParameter(&p_device);

  showMsg("Connecting WiFi", "Auto connect...", "or join FP-Setup");
  wm.setConfigPortalTimeout(120);
  wm.setSaveParamsCallback([&]() {
    prefs.begin("atd", false);
    prefs.putString("server_url", String(p_server.getValue()));
    prefs.putString("device_id",  String(p_device.getValue()));
    prefs.end();
    SERVER_URL = String(p_server.getValue());
    DEVICE_ID  = String(p_device.getValue());
  });

  bool connected = wm.autoConnect("FP-Setup", "12345678");
  if (!connected) {
    showMsg("WiFi Failed!", "Restarting...", "");
    delay(2000);
    ESP.restart();
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

  // เปิด Hardware Watchdog — reset อัตโนมัติถ้าค้างเกิน 25s
  esp_task_wdt_init(WDT_TIMEOUT, true);
  esp_task_wdt_add(NULL);
}

// ===== LOOP =====
void loop() {
  esp_task_wdt_reset();  // บอก watchdog ว่ายังทำงานปกติ

  // WiFi reconnect ทุก 60s
  checkWifi();

  if (millis() - lastPoll > 3000) {
    lastPoll = millis();
    checkEnrollCmd();
    checkSensorClearCmd();
  }

  if (millis() - lastClock > 1000) {
    lastClock = millis();
    showMain();
  }

  int id = scanFinger();
  if (id > 0) {
    beepOK();
    sendAttendance(id);
    delay(3000);
    showMain();
  } else if (id == -2) {
    beepNotFound();
    showNotFound();
    delay(2500);
    showMain();
  }

  delay(100);
}
