#include "Task.h"

Task::Task(LinkedList<Zone*>* zones, unsigned long duration)
    : zones(zones), duration(duration), isActive(false), globalStartTime(0) {
    id = random(0, 1000000);
}

void Task::start() {
    for (int i = 0; i < zones->size(); i++) {
        zones->get(i)->start(duration);
    }

    startTime = millis();
    globalStartTime = getCurrentTime();

    isActive = true;
}

void Task::check() {
    if (isActive && (millis() - startTime >= duration)) {
        stop();
    }
}

void Task::stop() {
    if (!isActive) return;

    for (int i = 0; i < zones->size(); i++) {
        zones->get(i)->stop();
    }

    isActive = false;
}

bool Task::isRunning() { return isActive; }

int Task::getId() { return id; }

unsigned long Task::getGlobalStartTime() { return globalStartTime; }

int Task::getDuration() { return duration; }

LinkedList<Zone*>* Task::getZones() { return zones; }

Task::~Task() { delete zones; }