# Smart Irrigation Controller

## Introduction

This irrigation controller allows you to remotely control, schedule, and monitor your irrigation system. It is designed to be used with a ESP32 and a 8 channel relay board. If you want to use the web interface, you will also need a device to host its docker image.

## Features

- Queue quick tasks for immediate execution
- Manage currently running tasks
- Schedule tasks to run on specific days and times of the week
  - Schedules can be a sequence of tasks, a single task with multiple zones, or a combination of both
- Monitor the status of your irrigation system
- View the history of past tasks

## Hardware

- ESP32
- 8 channel relay board
- 24VAC transformer
- 24VAC solenoid valves
- 3 x buttons
- 3 x 10k ohm resistors
- Connecting wires
- Large breadboard/protoboard

## Deployment

### Web Interface

```bash
# Clone the repository
git clone https://github.com/Moulik-Budhiraja/Sprinkler-System

# Change directory
cd Sprinkler-System/server

# Deploy the stack
docker-compose up -d
```

### ESP32

1. Wire the relay board to the ESP32 as defined by the pin-outs in `microcontroller/microcontroller.ino`
1. Change the respective variables inside `microcontroller/microcontroller.ino` to your wifi credentials and the IP address of the web interface
1. Flash the ESP32 with the code in the `microcontroller` directory
1. Plug in your microcontroller and you're good to go!

## Screenshots

<p float="left">
  <img src="/Assets/Images/esp32.png" alt="ESP32" width="100" />
  <img src="/Assets/Images/web-interface.png" alt="Web Interface" width="100" />
</p>

## Authors

- [@Moulik-Budhiraja](https://github.com/Moulik-Budhiraja)
