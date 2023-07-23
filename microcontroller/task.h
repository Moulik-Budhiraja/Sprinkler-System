#ifndef TASK_H
#define TASK_H
#include <Arduino.h>
#include <LinkedList.h>

#include "Zone.h"
#include "helpers.h"

class Task {
   private:
    LinkedList<Zone*>* zones;
    unsigned long duration;
    bool isActive;
    unsigned long startTime;
    unsigned long globalStartTime;
    int id;

   public:
    Task(LinkedList<Zone*>* zones, unsigned long duration);
    void start();
    void check();
    void stop();
    bool isRunning();
    int getId();
    unsigned long getGlobalStartTime();
    int getDuration();
    LinkedList<Zone*>* getZones();
    ~Task();
};

#endif