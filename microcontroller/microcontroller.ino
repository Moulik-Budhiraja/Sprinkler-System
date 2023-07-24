#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <LinkedList.h>
#include <LiquidCrystal.h>
#include <Ticker.h>
#include <WebServer.h>
#include <WiFi.h>

#include "button.h"
#include "helpers.h"
#include "menuClasses.h"
#include "task.h"
#include "time.h"
#include "zone.h"

const char* ssid = "REDACTED";
const char* password = "REDACTED";

const char* ntpServer = "time.nist.gov";

const String sprinklerWebServer = "REDACTED";

enum WiFiStates { DISCONNECTED, CONNECTING, CONNECTED };
WiFiStates WiFiState = DISCONNECTED;

Ticker wifiTicker;

LiquidCrystal lcd(32, 33, 25, 26, 27, 14);

WebServer server(80);

LinkedList<Task*> taskQueue = LinkedList<Task*>();

MenuManager menuManager = MenuManager();

Menu mainMenu = Menu("Main Menu");
Menu zoneMenu = Menu("Zone Menu");
Menu durationMenu = Menu("Duration Menu");
Menu runningMenu = Menu("Sprinkler Active");

ButtonHandler buttonHandler = ButtonHandler(39, 34, 35);

Zone zones[] = {Zone(23, 1), Zone(22, 2), Zone(21, 3), Zone(19, 4),
                Zone(18, 5), Zone(17, 6), Zone(16, 7), Zone(4, 8)};

void setup() {
    // put your setup code here, to run once:
    Serial.begin(115200);

    lcd.begin(16, 2);

    // Connect to wifi
    WiFi.begin(ssid, password);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }

    Serial.println("Connected to the WiFi network");
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());

    WiFiState = CONNECTED;

    configTime(0, 0, ntpServer);

    setenv("TZ", "EST5EDT,M3.2.0/2,M11.1.0", 1);
    tzset();

    Serial.print("Waiting for time to be set...");
    while (time(nullptr) < 100000) {
        Serial.print(".");
        delay(1000);
    }
    Serial.println("\nTime set!");

    // Populate menus

    // Main menu
    mainMenu.addOption(new MenuOption("Ready", []() {
        Serial.println("Ready");
        menuManager.pushMenu(&zoneMenu);
    }));

    // Zone menu
    for (int i = 1; i <= 8; i++) {
        zoneMenu.addOption(new MenuOption("Zone " + String(i), []() {
            Serial.println("Zone Selected");
            menuManager.pushMenu(&durationMenu);
        }));
    }

    // Duration menu
    const int durations[] = {15, 20, 25, 30, 45, 60, 1, 2, 3, 4, 5, 10};
    for (int i = 0; i < 12; i++) {
        durationMenu.addOption(new MenuOption(String(durations[i]) + " min",
                                              handleDurationMenuInteraction));
    }

    // Running menu
    runningMenu.addOption(new MenuOption("Stop", []() {
        Serial.println("Stopping Sprinkler");

        // Stop all tasks
        for (int i = 0; i < taskQueue.size(); i++) {
            taskQueue.get(i)->stop();
            sendEventDetails(taskQueue.get(i), "Stopped", "Manual");
        }

        // Clear task queue
        taskQueue.clear();

        menuManager.popMenu();
    }));

    menuManager.pushMenu(&mainMenu);

    // Server routes
    server.on("/tasks", HTTP_GET, handleGetTasks);
    server.on("/tasks/add", HTTP_POST, handleAddTasks);
    server.on("/tasks/delete", HTTP_DELETE, handleDeleteTask);
    server.onNotFound(handleNotFound);

    wifiTicker.attach_ms(500, checkWiFi);

    server.begin();
}

void loop() {
    server.handleClient();

    processTaskQueue();

    // Handle Buttons
    if (buttonHandler.prevPressed()) {
        menuManager.prevOption();
    }

    if (buttonHandler.selectPressed()) {
        menuManager.activateOption();
    }

    if (buttonHandler.nextPressed()) {
        menuManager.nextOption();
    }
}

void handleAddTasks() {
    if (server.hasArg("plain") == false) {  // Check if body data has been sent
        server.send(400, "application/json", "{\"error\":\"Body not found\"}");
        return;
    }

    DynamicJsonDocument doc(1024 * 16);
    deserializeJson(doc, server.arg("plain"));

    if (doc.containsKey("tasks")) {
        JsonArray tasks = doc["tasks"];

        for (JsonVariant task : tasks) {
            JsonArray zones = task["zones"];
            int runTime = task["runTime"];

            LinkedList<Zone*>* zoneArray = new LinkedList<Zone*>();

            for (JsonVariant zone : zones) {
                zoneArray->add(&::zones[zone.as<int>() - 1]);
            }

            taskQueue.add(new Task(zoneArray, runTime * 60000));
        }
        server.send(200, "application/json",
                    "{\"message\":\"Tasks added successfully\"}");

    } else {
        server.send(400, "application/json", "{\"error\":\"tasks not found\"}");
    }
}

void handleDeleteTask() {
    if (server.hasArg("id")) {
        String id = server.arg("id");
        bool found = false;

        for (int i = 0; i < taskQueue.size(); i++) {
            Task* task = taskQueue.get(i);

            if (String(task->getId()) == id) {
                task->stop();
                taskQueue.remove(i);

                delete task;

                if (taskQueue.size() == 0) {
                    menuManager.clear();
                    menuManager.pushMenu(&mainMenu);
                }

                found = true;
                break;
            }
        }

        if (found) {
            server.send(200, "application/json",
                        "{\"message\":\"Task deleted successfully\"}");
        } else {
            server.send(404, "application/json",
                        "{\"error\":\"Task not found\"}");
        }
    } else {
        server.send(400, "application/json", "{\"error\":\"id not provided\"}");
    }
}

void handleGetTasks() {
    DynamicJsonDocument doc(1024 * 16);
    JsonArray tasks = doc.createNestedArray("tasks");

    for (int i = 0; i < taskQueue.size(); i++) {
        Task* task = taskQueue.get(i);
        JsonObject taskObject = tasks.createNestedObject();

        LinkedList<Zone*>* zones = task->getZones();
        JsonArray jsonZones = taskObject.createNestedArray("zones");

        for (int j = 0; j < zones->size(); j++) {
            jsonZones.add(zones->get(j)->getNumber());
        }

        taskObject["id"] = task->getId();
        taskObject["startTime"] = task->getGlobalStartTime();
        taskObject["runTime"] = task->getDuration() / 60000;
    }

    String response;
    serializeJson(doc, response);
    server.send(200, "application/json", response);
}

void handleNotFound() { server.send(404, "text/plain", "Not found"); }

void checkWiFi() {
    switch (WiFiState) {
        case DISCONNECTED:
            Serial.println("Starting connection to WiFi...");
            WiFi.begin(ssid, password);
            WiFiState = CONNECTING;
            break;
        case CONNECTING:
            if (WiFi.status() == WL_CONNECTED) {
                Serial.println("Connected to WiFi!");
                Serial.print("IP address: ");
                Serial.println(WiFi.localIP());
                WiFiState = CONNECTED;
            } else {
                Serial.print(".");
            }
            break;
        case CONNECTED:
            if (WiFi.status() != WL_CONNECTED) {
                Serial.println("Lost connection to WiFi!");
                WiFiState = DISCONNECTED;
            }
            break;
    }
}

void makePostRequest(String path, String httpRequestData) {
    HTTPClient http;
    http.begin(sprinklerWebServer + path);  // Specify request destination
    http.addHeader("Content-Type",
                   "application/json");  // Specify content-type header

    int httpResponseCode = http.POST(httpRequestData);  // Send the request

    if (httpResponseCode > 0) {  // Check for the returning code
        String response = http.getString();
        Serial.println(httpResponseCode);
        Serial.println(response);
    } else {
        Serial.print("Error on sending POST: ");
        Serial.println(httpResponseCode);
    }

    http.end();  // Free the resources
}

void sendEventDetails(Task* task, String event, String reason) {
    String zoneString = "";

    for (int i = 0; i < task->getZones()->size(); i++) {
        zoneString += String(task->getZones()->get(i)->getNumber());
        if (i != task->getZones()->size() - 1) {
            zoneString += ",";
        }
    }

    // Prepare your HTTP POST request data
    String httpRequestData = "{\"event\":\"" + event + "\", \"reason\":\"" +
                             reason + "\", \"zones\":[" + zoneString + "]}";

    makePostRequest("/api/history/create", httpRequestData);
}

void processTaskQueue() {
    if (taskQueue.size() > 0) {
        Task* currentTask = taskQueue.get(0);

        if (!currentTask->isRunning()) {
            startTask(currentTask);
        }
        currentTask->check();  // Check the status of the task

        if (!currentTask->isRunning()) {
            taskQueue.remove(0);  // Remove task from the queue if it's finished

            sendEventDetails(currentTask, "Stopped", "Completed");

            delete currentTask;

            menuManager.clear();
            menuManager.pushMenu(&mainMenu);
        }
    }
}

void startTask(Task* task) {
    task->start();  // Start the task if it's not already running
    Serial.print("Task started ID: ");
    Serial.println(task->getId());

    // make the menu stack mainMenu -> runningMenu
    menuManager.clear();
    menuManager.pushMenu(&mainMenu);
    menuManager.pushMenu(&runningMenu);
}

void handleDurationMenuInteraction() {
    // Extract zone and duration from menu stack
    int zone = menuManager.getSelectHistory()->get(1).charAt(5) - '0';

    // Duration can be 1-2 digits
    int duration =
        menuManager.getCurrentMenu()
            ->getCurrent()
            .substring(0,
                       menuManager.getCurrentMenu()->getCurrent().length() - 4)
            .toInt();

    // Add task to queue
    LinkedList<Zone*>* zoneArray = new LinkedList<Zone*>();
    zoneArray->add(&zones[zone - 1]);
    taskQueue.add(new Task(zoneArray, duration * 60000));

    menuManager.popMenu();
    menuManager.popMenu();
    menuManager.pushMenu(&runningMenu);

    sendEventDetails(taskQueue.get(taskQueue.size() - 1), "Started", "Manual");
}
