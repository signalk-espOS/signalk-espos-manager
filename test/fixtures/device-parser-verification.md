# Verifying a generated manifest against the device's own parser

`generated-manifest.json` is a manifest this plugin produced and a real
signalk-server 2.32.0 actually served. It was then fed to espOS's own
`espos_ota_manifest_pick()` — compiled from
`components/espos_ota/src/manifest.c` — rather than to a reimplementation,
because the only opinion that matters about a manifest is the device's.

Result on 2026-09-20 (espOS main, 0.10.0):

| device state                                                       | verdict                 |
| ------------------------------------------------------------------ | ----------------------- |
| app `cockpit`, target `esp32p4`, running `1.1.0-12-g44590ce-dirty` | ACCEPTED, `newer = yes` |
| app `cockpit`, target `esp32p4`, running `1.3.0`                   | ACCEPTED, `newer = no`  |
| app `p4-cockpit` (the repo name, not the `project()` name)         | REJECTED                |
| target `esp32c6`                                                   | REJECTED                |

The accepted cases resolved the root-relative build URL to
`http://192.168.0.148:3100/signalk-espos-manager/fw/cockpit/1.3.0/p4_cockpit-esp32p4-v1.3.0-ota.bin`,
confirming `espos_ota_resolve_url()` reassembles scheme and host as intended.

The two rejections are the `app`-name trap: espOS matches the manifest's
top-level `app` against `esp_app_desc_t.project_name` with `strcmp`, which is
`cockpit`, not the repository name `espos-p4-cockpit` and not
`espos_start_opts_t.app_name` (`p4-cockpit`). Getting it wrong produces
"no build for esp32p4/stable in the manifest" with no hint why.

To re-run:

```sh
mkdir mtest && cd mtest
cp path/to/espOS/components/espos_ota/src/manifest.c .
cp path/to/espOS/components/espos_ota/include/espos_ota_manifest.h .
cp path/to/espOS/managed_components/espressif__cjson/cJSON/cJSON.{c,h} .
cp -r path/to/espOS/test/fuzz/shim .        # provides esp_err.h
# main.c calls espos_ota_manifest_pick(buf, n, manifest_url, app, target,
#                                     "stable", running_version, &out)
gcc -I. -Ishim -o mtest main.c manifest.c cJSON.c -lm
./mtest generated-manifest.json \
    http://192.168.0.148:3100/signalk-espos-manager/fw/cockpit/manifest.json \
    cockpit esp32p4 1.1.0-12-g44590ce-dirty
```
