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

# Controller deployment: both values are mandatory
SPRINKLER_DEMO=0 \
SPRINKLER_PUBLIC_ORIGIN=https://sprinklers.example.test \
docker compose up -d
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

`SPRINKLER_DEMO` is mandatory and accepts exactly `0` or `1`; omission and all
other values fail before the service binds. Controller mode (`0`) also requires
`SPRINKLER_PUBLIC_ORIGIN` to be the canonical browser origin, including its
scheme and non-default port. Browser mutation origins are compared only with
that value, never with `Host` or forwarded headers.

For synthetic review only, set `SPRINKLER_DEMO=1` and provide the review URL as
`SPRINKLER_PUBLIC_ORIGIN`. Demo mode always uses an owned private temporary
datastore and in-memory controller, regardless of `MICROCONTROLLER_HOST`, and
cannot contact sprinkler hardware. Each demo process is isolated and cleans
only its own temporary data when it exits. Ephemeral localhost tests that
cannot know their port before binding may additionally set
`SPRINKLER_TEST_ORIGIN=1`; startup rejects that mode unless demo mode is active.

The JSON datastore acknowledges a mutation only after the same canonical v2
envelope has replaced and been synced as both the primary file and its recovery
snapshot. Its checksum binds the format, monotonic revision, and complete
payload. On restart, the newest valid v2 revision repairs a missing, corrupt, or
older peer. Legacy payload-only snapshots migrate explicitly: a valid primary
wins without trusting legacy revision metadata, recovery is used only when the
primary is missing or invalid, and both peers are then rewritten as v2.
Schedule creation uses a client-stable request ID and atomically stores its
payload hash and resulting schedule ID with the schedule, so a lost response is
reconciled or retried with the same key rather than creating another schedule.
Cross-process writers use a renewable owner-token lease; an expired lock is
recovered only after its recorded process is dead or its process-start identity
no longer matches, and only the current owner token may release the lock.

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
