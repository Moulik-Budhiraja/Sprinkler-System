# Smart Irrigation Controller

![Sprinklers](/Assets/Images/lawn.jpg)

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

The default Compose binding is `127.0.0.1:5000`; physical controls are not
published to the LAN. Open the dashboard on the host or through an operator
SSH tunnel. Cross-site browser mutations are rejected and the UI cannot be
framed.

Network exposure is opt-in. If remote access is required, place the loopback
service behind an authenticated same-origin reverse proxy, or bind it only to
a restricted management VLAN protected by host/network firewall policy. Do
not publish port 5000 directly to an untrusted network: the application does
not embed or distribute an operator password.

For synthetic review only, start with `SPRINKLER_DEMO=1`. Demo mode uses an
owned private temporary datastore and an in-memory controller that cannot
contact sprinkler hardware. Each demo process is isolated and cleans only its
own temporary data when it exits.

### ESP32

1. Wire the relay board to the ESP32 as defined by the pin-outs in `microcontroller/microcontroller.ino`
1. Change the respective variables inside `microcontroller/microcontroller.ino` to your wifi credentials and the IP address of the web interface
1. Flash the ESP32 with the code in the `microcontroller` directory
1. Plug in your microcontroller and you're good to go!

## Screenshots

<p float="left">
  <img src="/Assets/Images/esp32.png" alt="ESP32" width="600" />
  <img src="/Assets/Images/web-interface.png" alt="Web Interface" width="200" />
</p>

## Authors

- [@Moulik-Budhiraja](https://github.com/Moulik-Budhiraja)
