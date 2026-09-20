# signalk-espos-manager

Finds the [espOS](https://github.com/signalk-espOS/espOS) devices on your boat,
keeps their firmware up to date from a project registry, and flashes a new
board from the browser.

> **Status: early development.** Device discovery, the firmware mirror and
> update resolution work. Installing an update and the USB flasher are still
> being built. See [Roadmap](#roadmap).

## What it does

- **Finds your devices.** Browses `_espos._tcp` on the local network and lists
  every espOS device with its project, firmware version, chip and board.
  Devices on another VLAN can be added by address.
- **Mirrors firmware on the server.** Downloads signed images while you have
  internet and serves them locally, so an update works at anchor with no
  connection at all.
- **Updates devices.** One at a time by default, watching progress and
  confirming the new image only once the device comes back healthy — the
  device rolls itself back otherwise.
- **A store of projects.** Firmware projects (the P4 cockpit, the BLE gateway,
  and anything other developers publish) with changelogs and per-board
  compatibility.
- **Flashes a new board over USB** from the browser, for a board that has never
  been on your network.

## Requirements

- Signal K server 2.x on Node 22 or newer.
- espOS devices reachable on the local network.

## Install

From the Signal K **Appstore**, or in the server's data directory:

```sh
npm install signalk-espos-manager
```

Then restart the server and enable the plugin.

## How updates reach a device

A device fetches its update manifest from the Signal K server it is already
connected to (`ota.manifest_src = signalk`), from this plugin's public webapp
path — not from `/plugins/...`, which requires an administrator login that a
device does not have. The plugin points each device at the right path for you.

Firmware images are signed. A device only accepts an image signed with the key
it was originally flashed with, so switching a device from one project to
another is a USB operation, not an over-the-air one. The plugin says so rather
than offering an update that would be refused after the download.

## Privacy and network use

The plugin talks to devices on your own network and fetches the project
registry and firmware from GitHub over HTTPS. Nothing about your boat is sent
anywhere. With the mirror enabled, devices never contact the internet at all.

## Roadmap

| Phase | What it adds                                       | State |
| ----- | -------------------------------------------------- | ----- |
| 0     | Device discovery and the fleet list                | done  |
| 1a    | Firmware mirror and the manifest devices fetch     | done  |
| 1b    | Update resolution from the registry                | done  |
| 1c    | Installing an update, with progress and rollback   | next  |
| 2     | The project store UI, with per-board compatibility |       |
| 3     | The browser USB flasher for new boards             |       |

## Licence

Apache-2.0. See [LICENSE](LICENSE).
