# Browser checks

`webapp.mjs` drives the built webapp in a real browser against a running
Signal K server. It is not part of `npm test`, because it needs a server and a
network of espOS devices — it is run by hand before a UI change ships, and its
screenshots go in the pull request.

A rendered page is the only proof a UI works. Both defects found the first time
this ran were invisible to the type checker and the unit tests: release notes
rendered as a wall of raw markdown, and a section that read
"installed · no firmware published yet" without explaining how both could be
true.

One caution learned here: Playwright's `allTextContents()` strips layout, so
adjacent flex children look concatenated ("P4 Cockpitofficialinstalled") even
when they are correctly spaced on screen. Judge spacing from a screenshot, not
from extracted text.

## Running it

Use a scratch server, never the one the boat runs on. It needs only a config
directory that names the plugin and points discovery at the devices:

```sh
npm ci && npm run build
C=${TMPDIR:-/tmp}/sk-config
mkdir -p "$C/node_modules" "$C/plugin-config-data"
echo '{"name":"sk-e2e","version":"0.0.1","dependencies":{"signalk-espos-manager":"*"}}' \
  > "$C/package.json"
ln -sfn "$PWD" "$C/node_modules/signalk-espos-manager"
cat > "$C/plugin-config-data/signalk-espos-manager.json" <<'JSON'
{ "enabled": true,
  "configuration": {
    "discovery": { "mdns": true, "staticHosts": ["<device-ip>"] },
    "auth": { "fleetKey": "scratch-fleet-key-for-the-e2e-check" } } }
JSON
# Any built signalk-server checkout whose node_modules match its source:
(cd ../signalk-server && PORT=3100 EXTERNALPORT=3100 node . -c "$C") &

npm install --save-dev @playwright/test
npx playwright install chromium
node test/e2e/webapp.mjs
```

Screenshots land in `$TMPDIR`. Set `BASE` to point at another server.

The scratch config sets a fleet key so the script can open the question
behind Remove and dismiss it with "Keep it"; it fails if no key is set, if
the question does not close, or if the key is gone afterwards. Use a scratch
key, never the boat's: the manager contacts devices that ask for a key with
it.

## The hosted flasher

`flasher.mjs` walks the flasher's start screen, one job and one board card. It
needs no server or device: build, serve the page, and run it. It prints the
`updated` time of the registry index the page loaded, which belongs with the
screenshots in the pull request.

```sh
npm ci && npm run build
npx vite preview &
node test/e2e/flasher.mjs
```

Set `CHROMIUM` to a browser binary when Playwright's own is not installed.
