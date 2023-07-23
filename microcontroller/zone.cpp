#include "Zone.h"

Zone::Zone(int pin, int number)
    : pin(pin), number(number), duration(0), isActive(false) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);
}

void Zone::start(unsigned long duration) {
    this->duration = duration;
    this->startTime = millis();
    this->isActive = true;
    digitalWrite(pin, LOW);
}

void Zone::stop() {
    this->isActive = false;
    digitalWrite(pin, HIGH);
}

void Zone::check() {
    if (isActive && (millis() - startTime >= duration)) {
        stop();
    }
}

bool Zone::isRunning() { return this->isActive; }

int Zone::getNumber() { return this->number; }