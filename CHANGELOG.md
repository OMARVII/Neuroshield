# Changelog

All notable changes to NeuroShield are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-25

A rebuild of detection, the on-page UI and the toolbar popup, with fixes for several safety problems in 1.0.

### Fixed

- **12 Hz strobes, including red/blue, were not detected.** 1.0 sampled about 12 frames per second, so a 12 Hz flash looked constant. Every presented frame is now analyzed, and a 12 Hz strobe is hidden in about 0.3 seconds.
- **Changing settings in the popup didn't reach open tabs.** Turning protection off (or changing sensitivity) only took effect after a reload. Settings now apply to every open tab and frame immediately.
- **Smooth or ramped flashes could slip through** because transitions were measured between consecutive frames. They are now measured peak to peak.
- **Red ↔ black and red ↔ blue flashing wasn't reported as red flashing**, and red ↔ green flashing (almost no brightness change) wasn't caught at all. Red flashes now follow the WCAG saturated-red definition.
- **Typical reds weren't counted as red flashes.** The red ratio was taken on sRGB values and averaged per sample, so camera-type reds (like 160, 25, 25) and red areas next to black never qualified. It now uses linear values from each area's summed light, as WCAG defines it.
- **A flash centred where analysis regions meet was split four ways** and could be missed. Regions now overlap.
- **Fine patterns were averaged incorrectly.** The 32×32 downscale skipped most pixels and averaged in gamma space. Frames are now averaged over every pixel in linear light.
- **The warning overlay let 15% of the flashing through** (85% black shield), drifted while scrolling, could be restyled by page CSS, and could end up behind fullscreen video. Flashing elements are now blacked out directly, and the card sits in the top layer inside an isolated shadow root.
- **"Dimmed — click to restore" did nothing when clicked**, and dimming (brightness 0.3) could still flash above the WCAG threshold. The new dimming is measured to stay below it.
- **Resuming a paused video turned protection off for it**, and pressing Escape revealed flashing content. Protection now re-arms 10 seconds after "Show anyway", and on every new video source.
- **Cross-origin videos got a blocking overlay right away**, even when nothing flashed. They now get a small notice, which can be set to dim them or to do nothing.
- **Videos inside shadow DOM** (Reddit, Mux, media-chrome and other web-component players) were never checked.
- **Tabs open during install or update weren't protected** until reloaded.
- Per-tab counts in the popup were wrong on pages with iframes, the toolbar badge could stay on a tab after navigating away, CSS animation detectors leaked and kept running after their elements were removed, and paused videos kept a 60 Hz animation loop running.

### Added

- Canvas protection (2D and WebGL, transparent or not), including HTML5 ads and games.
- Videos in picture-in-picture stay protected while you scroll the page.
- Per-site pause, from the popup or the settings page.
- The popup says "Partly protected" when a video on the page can't be checked, and tells you when NeuroShield can't run on a page instead of showing the previous page's numbers.
- The on-page card works inside modal dialogs (lightboxes), stays within scrolling panes, lines up on zoomed pages, can't be closed by the page, and follows its video in the keyboard order.
- "Hide everything on this page": <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> or the popup button pauses all media and covers the page.
- "Test protection" on the settings page: runs a strobe off screen through the real detector and shows the card you'd see, so you can check NeuroShield works without anything flashing.
- Options page with a welcome screen, sensitivity descriptions, paused-sites list and settings for pausing and unscannable videos.
- Setting to pause videos when flashing is hidden (on by default).
- End-to-end tests that load the extension into Chromium and play real flashing videos, plus unit tests for settings and tab state.
- Packaging script, release workflow, benchmark script and technical documentation ([docs/how-it-works.md](docs/how-it-works.md)).

### Changed

- **Sensitivity matches WCAG exactly.** Medium hides *more than* three flashes in a second; WCAG allows three. Beat-synced lighting at 128 BPM, a triple camera flash or a lightning flicker are no longer hidden at Medium. Low and High moved the same way (more than 5, more than 2); Maximum still hides any flash.
- **Size counts.** Flashes too small on screen to reach the WCAG area (a quarter of a 10° field of view) are ignored, and videos smaller than that (thumbnails, hover previews) aren't analyzed at all. Fewer false alarms on small players, less work on busy feeds.
- New design for the icon, popup and on-page card, with light and dark themes and reduced-motion support.
- Frame reading uses an asynchronous WebGL readback: about 40% less main-thread time than 1.0 on a 1080p60 video while analyzing five times as many frames, and no more console warnings on pages.
- Requires Chrome 116 or later.
- New permissions: `scripting` and host access, used only to start protection in tabs that were already open. Chrome's install warning is unchanged.

## [1.0.0] - 2026-03-21

### Added

- Real-time flash detection using WCAG 2.3.1 luminance thresholds with sRGB linearization
- Works on every website via Chrome content scripts
- Warning overlay with dim, pause, and continue controls
- Protective CSS filter fallback for cross-origin videos
- Four sensitivity levels: low (5 Hz), medium (3 Hz, WCAG default), high (2 Hz), maximum (1 Hz)
- Accessible overlay with ARIA roles, keyboard navigation, and screen reader support
- Resilient architecture: survives extension updates and service worker restarts
- 84 unit tests covering the full detection pipeline
- ESLint configuration for code quality
- Privacy policy (zero data collection)

[1.1.0]: https://github.com/OMARVII/Neuroshield/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/OMARVII/Neuroshield/releases/tag/v1.0.0
