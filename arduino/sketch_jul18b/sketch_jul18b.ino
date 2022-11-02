#include <Arduino_JSON.h>
#include <HTTPClient.h>
#include <LiquidCrystal.h>
#include <WiFi.h>

#include "time.h"

String httpGETRequest(String serverName) {
    WiFiClient client;
    HTTPClient http;

    // Your Domain name with URL path or IP address with path
    http.begin(client, serverName);

    //  Serial.print(serverName);
    //
    //  Serial.print("  |  ");

    // Send HTTP POST request
    int httpResponseCode = http.GET();

    String payload = "{}";

    if (httpResponseCode > 0) {
        payload = http.getString();
    }

    // Free resources
    http.end();

    //  Serial.println(payload);

    return payload;
}

void httpPOSTRequest(char* serverName, char* payload) {
    WiFiClient client;
    HTTPClient http;

    http.begin(client, serverName);

    http.addHeader("Content-Type", "application/json");

    http.POST(String(payload));

    http.end();
}

class Button {
   private:
    byte pin;
    byte state;
    byte lastReading;

   public:
    static unsigned long lastInteraction;
    static unsigned long lastInteractionDelta;

    Button(byte pin) {
        this->pin = pin;
        lastReading = LOW;
        init();
    }

    void init() {
        pinMode(pin, INPUT);
        update();
    }

    void update() {
        byte newReading = digitalRead(pin);

        if (newReading) {
            lastInteraction = millis();
        }

        if (newReading != lastReading && newReading == HIGH) {
            state = HIGH;
        } else {
            state = LOW;
        }

        lastReading = newReading;
    }

    byte getState() {
        update();
        return state;
    }

    bool isPressed() { return (getState() == HIGH); }
};

class Zone {
   private:
    byte pin;

   public:
    int zone;
    byte state;
    unsigned long startTime;
    unsigned long runTime;

    Zone(byte pin, int zone) {
        this->pin = pin;
        this->zone = zone;
        state = HIGH;
        init();
    }

    void init() {
        pinMode(pin, OUTPUT);
        stop();
    }

    void start(unsigned long runtime) {
        startTime = millis();
        runTime = runtime;
        state = LOW;
        digitalWrite(pin, state);
        httpGETRequest(String("http://192.168.50.3:5000/?accessoryId=zone") +
                       String(zone) + String("&state=") + String("true"));
    }

    void queueStart(unsigned long waittime, unsigned long runtime) {
        startTime = millis() + waittime * 60 * 1000;
        runTime = runtime;
        httpGETRequest(String("http://192.168.50.3:5000/?accessoryId=zone") +
                       String(zone) + String("&state=") + String("true"));
    }

    void millisQueueStart(unsigned long waittime, unsigned long runtime) {
        startTime = millis() + waittime;
        runTime = runtime;
        httpGETRequest(String("http://192.168.50.3:5000/?accessoryId=zone") +
                       String(zone) + String("&state=") + String("true"));
    }

    void stop() {
        startTime = 0;
        runTime = 0;
        state = HIGH;
        digitalWrite(pin, state);
    }

    byte isRunning() { return state == LOW; }

    int timeRemaining() {
        unsigned long endTime = startTime + runTime * 60 * 1000;

        if (millis() > endTime) {
            if (state == LOW) {
                stop();
                httpGETRequest(
                    String("http://192.168.50.3:5000/?accessoryId=zone") +
                    String(zone) + String("&state=") + String("false"));
            }
            return 0;
        }

        if (millis() > startTime && millis() < endTime) {
            state = LOW;
            digitalWrite(pin, state);
        }

        return (endTime - millis()) / 1000 / 60;
    }
};

const char* ssid = "";      // Redacted
const char* password = "";  // Redacted

const char* ntpServer = "pool.ntp.org";
const long gmtOffset_sec = -3600 * 5;
const int daylightOffset_sec = 3600;

LiquidCrystal lcd(32, 33, 25, 26, 27, 14);

Button leftButton = Button(39);
Button middleButton = Button(34);
Button rightButton = Button(35);

unsigned long Button::lastInteraction = millis();
unsigned long Button::lastInteractionDelta;

int menuState = 0;
unsigned long menuTime = 0;
unsigned long menuDeltaTime;

const int totalZones = 8;
Zone zones[8] = {Zone(23, 1), Zone(22, 2), Zone(21, 3), Zone(19, 4),
                 Zone(18, 5), Zone(17, 6), Zone(16, 7), Zone(4, 8)};
int selectedZone = -1;

const int times[13] = {1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 45, 50, 60};
const int totalTimes = 13;
int selectedTime = 5;

struct tm lastWatered;

unsigned long lastRequestTime = 0;

unsigned long resetTime = 3600000 * 3;

void setup() {
    lcd.begin(16, 2);

    Serial.begin(9600);

    WiFi.begin(ssid, password);

    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
    }

    configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);

    if (!getLocalTime(&lastWatered)) {
        Serial.println("Failed to obtain time");
    }
}

void loop() {
    if (millis() - lastRequestTime > 3000) {
        if (WiFi.status() == WL_CONNECTED) {
            String stringtasks =
                httpGETRequest("http://192.168.50.3:5001/api/get-active");
            JSONVar tasks = JSON.parse(stringtasks);
            JSONVar task = tasks[0];

            if (long(task["total_zones"]) > 0) {
                String id = JSON.stringify(task["id"]);
                JSONVar activeZones = task["zones"];
                JSONVar activeRunTime = task["run_time"];
                JSONVar individual = task["individual"];
                long totalActiveZones = task["total_zones"];
                long totalRunTime = long(task["total_run_time"]);

                if (!bool(individual)) {
                    for (int i = 0; i < totalActiveZones; i++) {
                        long zoneNumber = long(activeZones[i]);
                        zones[zoneNumber - 1].start(long(totalRunTime) / 1000 /
                                                    60);
                    }
                } else {
                    unsigned long maxEndTime = 0;

                    for (int i = 0; i < totalZones; i++) {
                        if (zones[i].startTime + zones[i].runTime * 60 * 1000 >
                            maxEndTime) {
                            maxEndTime = zones[i].startTime +
                                         zones[i].runTime * 60 * 1000;
                        }
                    }

                    if (maxEndTime > millis()) {
                        for (int i = 0; i < totalActiveZones; i++) {
                            long zoneNumber = long(activeZones[i]);
                            zones[zoneNumber - 1].millisQueueStart(
                                maxEndTime - millis() + long(totalRunTime) * i,
                                long(totalRunTime) / 1000 / 60);
                        }
                    } else {
                        for (int i = 0; i < totalActiveZones; i++) {
                            long zoneNumber = long(activeZones[i]);
                            zones[zoneNumber - 1].millisQueueStart(
                                long(totalRunTime) * i,
                                long(totalRunTime) / 1000 / 60);
                        }
                    }
                    //            for (int i = 0; i < totalActiveZones; i++) {
                    //              long zoneNumber = long(activeZones[i]);
                    //              if (i == 0) {
                    //                zones[zoneNumber -
                    //                1].start(long(totalRunTime) / 1000 / 60);
                    //              } else {
                    //                zones[zoneNumber -
                    //                1].queueStart(totalRunTime / 1000 / 60 *
                    //                i, totalRunTime / 1000 / 60);
                    //              }
                    //
                    //            }
                }

                Serial.println(task);
                httpGETRequest(
                    String("http://192.168.50.3:5001/api/start-task?id=") +
                    String(id));
            }

            for (int i = 1; i < totalZones + 1; i++) {
                String stringHomekit = httpGETRequest(
                    String("http://192.168.50.3:5000/?accessoryId=zone") +
                    String(i));
                JSONVar homekitStatus = JSON.parse(stringHomekit);

                int state = int(homekitStatus["state"]);

                if (state == 1) {
                    if (zones[i - 1].startTime +
                            zones[i - 1].runTime * 60 * 1000 <
                        millis()) {
                        unsigned long maxEndTime = 0;

                        for (int j = 0; j < totalZones; j++) {
                            if (zones[j].startTime +
                                    zones[j].runTime * 60 * 1000 >
                                maxEndTime) {
                                maxEndTime = zones[j].startTime +
                                             zones[j].runTime * 60 * 1000;
                            }
                        }

                        if (maxEndTime > millis()) {
                            zones[i - 1].millisQueueStart(maxEndTime - millis(),
                                                          15);
                        } else {
                            zones[i - 1].start(15);
                        }
                    }
                } else {
                    if (zones[i - 1].startTime +
                            zones[i - 1].runTime * 60 * 1000 >
                        millis()) {
                        for (int j = 0; j < totalZones; j++) {
                            if (zones[j].startTime > zones[i - 1].startTime) {
                                if (zones[i - 1].isRunning()) {
                                    zones[j].startTime -=
                                        zones[i - 1].runTime * 60 * 1000 +
                                        zones[i - 1].startTime - millis();
                                } else {
                                    zones[j].startTime -=
                                        zones[i - 1].runTime * 60 * 1000;
                                }
                            }
                        }
                        zones[i - 1].stop();
                    }
                }
            }
        }

        lastRequestTime = millis();
    }

    menuDeltaTime = millis() - menuTime;
    Button::lastInteractionDelta = millis() - Button::lastInteraction;
    if (menuState == 0) {
        lcd.setCursor(0, 0);
        lcd.print("  System Ready  ");

        lcd.setCursor(0, 1);

        if (WiFi.status() == WL_CONNECTED) {
            lcd.print("     Online     ");
        } else {
            lcd.print("     Offline    ");
        }

        if (middleButton.isPressed()) {
            menuState = 1;
            menuTime = millis();
        }
    } else if (menuState == 1) {
        lcd.setCursor(0, 0);
        lcd.print("  Select Zone    ");

        lcd.setCursor(0, 1);
        if (selectedZone == -1) {
            lcd.print("   All Zones    ");
        } else {
            lcd.print("    Zone: ");
            lcd.print(selectedZone + 1);
            lcd.print("     ");
        }

        if (rightButton.isPressed()) {
            selectedZone++;
        }

        if (leftButton.isPressed()) {
            selectedZone--;
        }

        if (selectedZone >= totalZones) {
            selectedZone = -1;
        } else if (selectedZone < -1) {
            selectedZone = totalZones - 1;
        }

        if (middleButton.isPressed()) {
            menuState = 2;
            menuTime = millis();
        }

    } else if (menuState == 2) {
        lcd.setCursor(0, 0);
        lcd.print("    Run Time   ");
        lcd.setCursor(0, 1);
        lcd.print("      ");
        lcd.print(times[selectedTime]);
        lcd.print("min       ");

        if (leftButton.isPressed()) {
            selectedTime--;
        }

        if (rightButton.isPressed()) {
            selectedTime++;
        }

        if (selectedTime >= totalTimes) {
            selectedTime = 0;
        } else if (selectedTime < 0) {
            selectedTime = totalTimes - 1;
        }

        if (middleButton.isPressed()) {
            if (selectedZone == -1) {
                for (int i = 0; i < totalZones; i++) {
                    zones[i].start(times[selectedTime]);
                }
            } else {
                zones[selectedZone].start(times[selectedTime]);
            }
        }

    } else if (menuState == 3) {
        lcd.setCursor(0, 0);
        lcd.print(" System Running ");

        int maxTimeLeft = 0;

        for (int i = 0; i < totalZones; i++) {
            if (maxTimeLeft < zones[i].timeRemaining()) {
                maxTimeLeft = zones[i].timeRemaining();
            }
        }

        lcd.setCursor(0, 1);
        lcd.print("     ");
        lcd.print(maxTimeLeft + 1);
        lcd.print(" min      ");

        if (middleButton.isPressed()) {
            for (int i = 0; i < totalZones; i++) {
                zones[i].stop();
                httpGETRequest(
                    String("http://192.168.50.3:5000/?accessoryId=zone") +
                    String(i + 1) + String("&state=") + String("false"));
            }
            menuState = 0;
            menuTime = millis();
        }

        bool zonesActive = false;

        for (int i = 0; i < totalZones; i++) {
            if (zones[i].isRunning()) {
                zonesActive = true;
                break;
            }
        }

        if (!zonesActive) {
            menuState = 0;
            menuTime = millis();
            if (!getLocalTime(&lastWatered)) {
                Serial.println("Failed to obtain time");
            }
        }
    }

    if (menuState != 3) {
        bool zonesActive = false;

        for (int i = 0; i < totalZones; i++) {
            if (zones[i].isRunning()) {
                zonesActive = true;
                break;
            }
        }

        if (Button::lastInteractionDelta > 15000) {
            if (!zonesActive) {
                menuState = 0;
                menuTime = millis();
                Button::lastInteraction = millis();
            }
        }

        if (zonesActive) {
            menuState = 3;
            menuTime = millis();
        }
    }

    for (int i = 0; i < totalZones; i++) {
        zones[i].timeRemaining();
    }

    if (millis() > resetTime) {
        bool allOff = true;

        for (int i = 0; i < totalZones; i++) {
            if (zones[i].startTime + zones[i].runTime * 60 * 1000 > millis()) {
                allOff = false;
                break;
            }
        }

        if (allOff) {
            ESP.restart();
        }
    }
}
