# Sprinkler System

---

## Overview

A sprinkler system controller that uses an ESP32 and a 8 channel relay board to control a sprinkler system. The ESP32 is connected to a local WiFi network and a web server is hosted on a raspberry pi 4. The ESP32 connects to the web server and polls for scheduled tasks to run. The ESP32 also communicates with a homebridge server to allow for control of the sprinkler system from an iOS device through the apple home app.

## Hardware

-   ESP32
-   8 channel relay board
-   Male to Female jumper wires
