#ifndef BUTTON_H
#define BUTTON_H

#include <Arduino.h>

class ButtonHandler {
   private:
    int prevButtonPin;
    int selectButtonPin;
    int nextButtonPin;
    bool prevPrevState;
    bool selectPrevState;
    bool nextPrevState;

   public:
    ButtonHandler(int prev, int select, int next);

    bool prevPressed();
    bool selectPressed();
    bool nextPressed();
};

#endif