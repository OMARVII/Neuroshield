# Contributing to NeuroShield

Thanks for helping. NeuroShield makes safety decisions for people with photosensitive epilepsy, so changes are held to a higher standard than in a typical extension. Please read this before opening a pull request.

## Before you start

1. Check the [open issues](https://github.com/OMARVII/Neuroshield/issues).
2. For anything bigger than a small fix, open an issue first so we can agree on the approach.
3. Fork the repository and work on a branch.

## Setup

You need Node 22 or later.

```bash
git clone https://github.com/OMARVII/Neuroshield.git
cd Neuroshield
npm install
npx playwright install chromium   # browser for the end-to-end tests
```

Load the extension: open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select the repository folder. There is no build step: the files in `src/` are what ships.

Content-script changes take effect when you reload the page. Service-worker changes need the **Reload** button on `chrome://extensions`.

## Commands

| Command | What it does |
|---|---|
| `npm run lint` | ESLint over the whole repository |
| `npm run test:unit` | Unit tests for the detector, settings and tab state (Node's test runner, no browser) |
| `npm run test:e2e` | Loads the extension into Chromium and plays real videos (Playwright) |
| `npm run validate` | Lint, unit tests and a package check (what CI runs first) |
| `npm run build` | Writes `dist/neuroshield-<version>.zip` for the Chrome Web Store |
| `npm run bench` | Main-thread cost on a 1080p60 video; `-- --compare <dir>` compares another build |
| `npm run screenshots` | Regenerates the README screenshots |
| `npm run icons` | Renders the PNG icons from `icons/source/*.svg` |
| `npm run media` | Regenerates the test videos in `test/e2e/media` (needs ffmpeg) |

## Tests are required

- All tests must pass.
- **Detection changes need evidence.** Add unit tests in `test/unit/detector.test.js` that show the behavior before and after, and an end-to-end case with a video fixture if the change affects real playback. A pull request that says "this should detect better" without tests will be closed.
- If NeuroShield missed something in the wild, the best fix starts with a fixture that reproduces it: add a clip to `scripts/make-media.sh` and a case to `test/e2e/detection.spec.js`.

## Code style

- **No dependencies in `src/`.** Development tools live in `devDependencies` and never ship.
- **One module per file.** Each file is a classic script that defines a single global (`var NeuroShieldX = (() => { 'use strict'; … })();`). Content scripts can't use ES modules, and this keeps every file loadable by the content scripts, the service worker and the Node tests.
- **Keep analysis pure.** `src/content/detector.js` must not touch the DOM, so it stays testable in Node.
- **Build DOM with `createElement`.** No `innerHTML`, `outerHTML` or `insertAdjacentHTML`; ESLint enforces this.
- **No `eval`, `new Function` or remote code.** Manifest V3 forbids them, and we wouldn't want them anyway.
- **The on-page UI must stay out of the page's reach.** It lives in a closed shadow root, and its buttons only react to real (trusted) input.
- **Cost matters.** Content scripts run in every frame of every page. Avoid timers and animation-frame loops that run while nothing is playing, and measure with `npm run bench` when touching the sampling path.
- Modern JavaScript (ES2022) is fine; Chrome 116 is the minimum.

## Pull requests

1. One change per pull request.
2. Update `CHANGELOG.md` for anything users would notice, and `README.md` or `docs/` if behavior changes.
3. Fill in the pull request template. A maintainer will review within a few days.

## Reporting problems

Use the [issue forms](https://github.com/OMARVII/Neuroshield/issues/new/choose). For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
