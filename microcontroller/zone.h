#ifndef ZONE_H
#define ZONE_H
#include <Arduino.h>

class Zone {
   private:
    int pin;
    int number;
    unsigned long duration;
    unsigned long startTime;
    bool isActive;

   public:
    Zone(int pin, int number);
    void start(unsigned long duration);
    void stop();
    void check();
    bool isRunning();
    int getNumber();
};

#endif