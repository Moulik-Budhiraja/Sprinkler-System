#include "button.h"

ButtonHandler::ButtonHandler(int prev, int select, int next)
    : prevButtonPin(prev),
      selectButtonPin(select),
      nextButtonPin(next),
      prevPrevState(false),
      selectPrevState(false),
      nextPrevState(false) {
    pinMode(prevButtonPin, INPUT);
    pinMode(selectButtonPin, INPUT);
    pinMode(nextButtonPin, INPUT);
}

bool ButtonHandler::prevPressed() {
    bool currentState = digitalRead(prevButtonPin) == HIGH;
    bool pressed = !prevPrevState && currentState;
    prevPrevState = currentState;
    return pressed;
}

bool ButtonHandler::selectPressed() {
    bool currentState = digitalRead(selectButtonPin) == HIGH;
    bool pressed = !selectPrevState && currentState;
    selectPrevState = currentState;
    return pressed;
}

bool ButtonHandler::nextPressed() {
    bool currentState = digitalRead(nextButtonPin) == HIGH;
    bool pressed = !nextPrevState && currentState;
    nextPrevState = currentState;
    return pressed;
}