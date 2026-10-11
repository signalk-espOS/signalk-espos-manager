# signalk-espos-manager

Finds the [espOS](https://github.com/signalk-espOS/espOS) devices on your boat,
keeps their firmware up to date from a project registry, and flashes a new
board from the browser.

> **Status: proven on hardware.** A new board has been flashed from the
> browser and an installed device has been updated over the air with this
> plugin.

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

Then restart the server. The plugin enables itself on first start with the
default settings; you can still turn it off under Plugin Config.

## Using it

The plugin adds an **espOS Manager** webapp to the Signal K server, with three
pages: **Devices**, **Firmware** and **New board**.

**Devices** names each board the way the flasher does: the product from the
registry's board catalogue, with its photo once the catalogue has one, and the
jobs its firmware does there, such as "Show instruments on a touch screen". A
device whose firmware does not report its board, or whose image runs on
several boards, is shown by its chip instead, since a wrong product name is
worse than none.

### Installing firmware on a new board

For a board that has never been on your network.

1. Plug the board into the computer running the browser by USB and open
   **New board**.
2. Pick the firmware. The page connects to the board, reads its chip and
   flash size, and checks the image fits before anything is written. If the
   chip has several boards, it asks which one this is.
3. Write it and wait for the progress bar to finish.
4. **Unplug the board and plug it back in.** It is reset after writing, but a
   full power cycle is what reliably starts the new firmware.
5. Join the open WiFi network named `espOS-` followed by four characters and
   enter your boat's network at <http://192.168.4.1/>.
6. Once it joins, it appears on the **Devices** page.

Browsers only allow USB access from a secure page. When your server is on
plain http, the page sends you to the
[hosted flasher](https://signalk-espos.github.io/signalk-espos-manager/flash/),
which does the same thing. The page also offers each image as a download for
writing with `esptool`.

The hosted flasher starts by asking what the board should do: show
instruments on a touch screen, bring Bluetooth sensors into Signal K, switch
loads, or connect an NMEA 2000 network. Each job lists the boards that do it,
best first, as the registry ranks them, and each board leads to its firmware
and where to buy it. Someone who already has a board picks **I already have
a board** and finds it in the list, or plugs it in to filter by chip. The jobs
and boards come from the registry's `usecases/` and `boards/` catalogue.

Plugging a board in also reads, without changing anything, the USB chip it
connects through and the name and version of the firmware already on it. When
that points at one catalogue board (the maker's demo it shipped with, or an
espOS project made only for that board), the page says "This looks like…" and
lists that board first. A shared USB chip on its own is only a hint, because
one vendor puts the same chip on many boards.

### Updating a device

1. Open the device from **Devices**. Its **Firmware updates** card shows the
   newest release for its project and board, with the release notes, and when
   the firmware list was last checked. **Check now** reads it again; it is
   also checked every hour.
2. Choose **Install update**. The card follows the update as it downloads,
   installs, restarts and is confirmed.
3. Once the device comes back and reports the new version, the plugin waits
   until it has looked healthy for a while (two minutes by default) and then
   confirms the new image. If nothing confirms it, the device rolls back to
   the previous firmware on its own.

A device running a build that is not a released version shows **Install
anyway**, since the release may be older than what it runs. A device that is
not pointed at this server for updates shows **Not set up for updates** with
a **Fix this** button. Updates run one device at a time unless you raise
**Simultaneous updates** in Plugin Config; the same place sets the update
channel, beta releases and the confirm timing. **Advanced** on the device page
can confirm or roll back the current image by hand.

A P4 board's radio co-processor (the chip that handles WiFi and Bluetooth)
runs firmware of its own. When it is older than the device's firmware expects,
the device page says so. Updating it from the manager needs device firmware
that supports it; until then the card says what to install first. While a
radio update runs, a firmware update waits for it to finish.

## How updates reach a device

A device fetches its update manifest from the Signal K server it is already
connected to (`ota.manifest_src = signalk`), from this plugin's public webapp
path — not from `/plugins/...`, which requires an administrator login that a
device does not have. The plugin points each device at the right path for you.

Firmware images are signed. A device only accepts an image signed with the key
it was originally flashed with, so switching a device from one project to
another is a USB operation, not an over-the-air one. The plugin says so rather
than offering an update that would be refused after the download.

## Two different keys

- **The signing key** belongs to whoever publishes a firmware project. They
  sign each release with it, and a device only installs updates signed with
  the key it was flashed with. Lose it and every device needs a USB reflash.
  The registry only records its fingerprint (`signingKeyId`). When both the
  registry and the device report a fingerprint, the plugin can tell an update
  the device would refuse; it never signs or checks firmware itself. A
  developer's own build signs with a key generated in
  their checkout, which only their own devices accept.
- **The fleet API key** (`auth.fleetKey`) is the password this plugin uses
  to talk to your devices' web API (`httpd.api_key` on the device). It has
  nothing to do with firmware. Changing it only means telling the plugin and
  the devices the new one. It is optional: with no key on your devices
  there is nothing to enter. The Devices page can generate a key, set your
  own, replace it or remove it. Replacing it writes the new key to every
  online device that used the old one; a device that is offline keeps the
  old key, which the plugin remembers for it, and gets the new one once it
  answers again. Removing it never
  opens a device: each one that used it keeps it as its own key.

## Privacy and network use

The plugin talks to devices on your own network and fetches the project
registry and firmware from GitHub over HTTPS. Nothing about your boat is sent
anywhere. With the mirror enabled, devices never contact the internet at all.
Board photos are loaded by your browser from wherever the registry's catalogue
points, and simply do not appear without internet.

## Roadmap

| Phase | What it adds                                       | State |
| ----- | -------------------------------------------------- | ----- |
| 0     | Device discovery and the fleet list                | done  |
| 1     | Firmware mirror, manifests, and installing updates | done  |
| 2     | The web interface                                  | done  |
| 3     | The browser USB flasher for new boards             | done  |

The firmware list comes from the
[espOS registry](https://github.com/signalk-espOS/registry), and boards can be
flashed from the [hosted flasher](https://signalk-espos.github.io/signalk-espos-manager/flash/)
when your server is on plain http (browsers only allow USB access from a
secure page).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
