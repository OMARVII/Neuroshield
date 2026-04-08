# Contributing to NeuroShield

Thanks for your interest. NeuroShield is a medical safety tool, so contributions
are held to a higher standard than a typical extension. Please read this before
opening a PR.

---

## Getting Started

1. Check the [open issues](../../issues) before starting work.
2. For anything non-trivial, open an issue first to discuss the approach.
   Surprises waste everyone's time.
3. Fork the repo and work on a dedicated branch.

---

## Development Setup

No build step required.

```bash
git clone https://github.com/OMARVII/Neuroshield.git
cd neuroshield
npm install   # dev dependencies only (linting, testing)
```

Load the extension in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the repo root

Changes to content scripts take effect on page reload. Changes to the background
service worker require clicking **Reload** on the extensions page.

---

## Testing

```bash
npm test        # run the full test suite
npm run lint    # check code style
```

All tests must pass before submitting a PR. If you're changing detection logic,
you must include a test case that demonstrates the behavior. This is not
optional. NeuroShield makes safety-relevant decisions and untested algorithm
changes will not be merged.

---

## Code Style

- **Module pattern:** wrap each file in an IIFE. No globals leaking out.
- **Strict mode:** `'use strict';` at the top of every IIFE.
- **No external dependencies in `src/`.** Dev tooling (test runners, linters)
  lives in `devDependencies` and never touches the extension bundle.
- **No `eval`, no `new Function`, no inline scripts.** Manifest V3 CSP forbids
  it and we don't want it anyway.
- **DOM construction via `createElement` only.** No `innerHTML`, no
  `insertAdjacentHTML`. This is a hard rule for XSS safety.
- Keep functions small and single-purpose. If a function needs a long comment
  to explain what it does, it probably needs to be split.

---

## Pull Request Process

1. Open an issue first for any non-trivial change. Trivial means: typo fixes,
   comment improvements, obvious one-line bugs.
2. One feature or fix per PR. Don't bundle unrelated changes.
3. Detection algorithm changes require test evidence showing the before/after
   behavior on real-world cases. A PR that says "this should work better" with
   no data will be closed.
4. Update any relevant documentation in the same PR.
5. A maintainer will review within a few days. Be prepared to iterate.

---

## Reporting Issues

Use the GitHub issue tracker. Include:

- Chrome version and OS
- A minimal reproduction (URL or steps)
- What you expected vs. what happened
- Console errors if any (`F12` > Console)

For security vulnerabilities, do not open a public issue. See
[SECURITY.md](SECURITY.md) for responsible disclosure instructions.
