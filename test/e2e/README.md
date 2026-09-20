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

```sh
# 1. Build and install the plugin into a scratch server (see the PR body for
#    the full recipe), start it on :3100, then:
npm install --save-dev @playwright/test
npx playwright install chromium
node test/e2e/webapp.mjs
```

Screenshots land in `$TMPDIR`. Set `BASE` to point at another server.
