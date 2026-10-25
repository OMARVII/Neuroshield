# How NeuroShield works

This page explains how NeuroShield decides that something is flashing, how it reads frames without slowing pages down, and where its limits are. It's written for contributors and for anyone who wants to check the reasoning behind a safety tool before trusting it.

## 1. What counts as a flash

NeuroShield follows the WCAG 2.x definitions behind success criterion 2.3.1 (*Three Flashes or Below Threshold*):

- **Relative luminance** is computed from sRGB by linearizing each channel (IEC 61966-2-1) and weighting with the ITU-R BT.709 coefficients: `L = 0.2126 R + 0.7152 G + 0.0722 B`.
- A **transition** is a change in relative luminance of at least **0.1** where the darker state is below **0.8**. Flicker between two bright states doesn't count.
- A **flash** is a pair of opposing transitions (dark → bright → dark).
- A **red transition** involves a *saturated red*: `R / (R + G + B) ≥ 0.8` and a change in `(R − G − B) × 320` of more than 20, with R, G and B linear as in the relative luminance definition. The ratio is taken from an area's summed light, so black parts of the area don't water down a red that's there. Red flashes are counted even when brightness hardly changes (red ↔ green), and any red flash makes a detection high-severity.
- Flashes smaller than **25% of a 10° visual field** (about 341 × 256 CSS px at typical viewing distance) are below the threshold.

Protection kicks in when any one-second window holds **more** flashes than the sensitivity allows: more than 5 (Low), more than 3 (Medium: WCAG passes "no more than three flashes in any one second"), more than 2 (High), or any complete flash (Maximum). In transitions that is 11, 7, 5 and 2. A strobe at exactly 3 per second sits on the Medium boundary: depending on where frames fall, it may or may not be hidden.

### Peak-to-peak counting

Version 1.0 compared each sample with the one before it. That only works when samples are far apart: at 60 frames per second, a smooth black-to-white flash changes by less than 0.1 between frames and goes uncounted. NeuroShield now tracks the extreme of the current swing (a "zig-zag" over the signal) and confirms a transition once the signal moves back from that extreme by 0.1 or more. Hard cuts count exactly as before, and ramps now count too. The test `detects a smooth sine flash that never changes 0.1 between two frames` shows the difference.

### Where in the frame

Each frame is reduced to 32×32 samples and analyzed at three scales: the whole frame, quarter-frame blocks, and a 4×4 grid of fine regions. A strobe confined to one corner barely moves the frame average, but it shows up clearly in its block or region. Blocks sit at overlapping positions and the fine grid has a second copy shifted by half a region, so a flash centred where regions meet isn't split four ways.

Scales are matched to how big the content is on screen. A fine region of a 640 × 360 player is 160 × 90 px, too small to hold a flash of the WCAG area, so for that player only blocks and the whole frame count; full screen, the fine regions count too. Videos smaller on screen than the WCAG area (thumbnails, hover previews) aren't analyzed at all, which also saves work on pages full of them. Browser and pinch zoom make content count as larger, never smaller.

## 2. Reading frames

### Every frame, not every fifth

Version 1.0 sampled roughly every 83 ms (12 per second on a 60 Hz display). A strobe at 12 Hz, the frequency of the Pokémon incident, hits the same phase on every sample and looks perfectly steady. NeuroShield now analyzes every frame the video presents, using `requestVideoFrameCallback`. That callback doesn't fire while a video is paused, so idle pages cost nothing.

When a page renders slower than the video (two videos at once, a busy page, Chrome's Energy Saver), callbacks skip frames the screen still shows. In the worst case they lock onto every other frame, and a strobe that alternates each frame again looks steady. NeuroShield notices the skipped frames from the callback metadata and takes extra samples between callbacks. In testing, this raised the share of transitions seen on a frame-alternating 24 fps strobe from 2% to about 50%, enough to detect it within half a second.

### Cheap readback

| Method (1080p60, per frame) | Median | Worst | Notes |
|---|---|---|---|
| v1.0: CPU canvas `drawImage` + `getImageData` | 3.5 ms | 28 ms | full-frame GPU→CPU copy; console warning |
| GPU canvas → CPU canvas (2D fallback) | 1.5 ms | 6 ms | |
| **WebGL sRGB mipmaps + async readback** | **0.2–0.3 ms** | **~1.4 ms** | used when a GPU is available |

The WebGL path uploads the frame into an `SRGB8_ALPHA8` texture and lets the GPU build mipmaps, which averages in linear light. It then reads the 32×32 result through a pixel-buffer object guarded by a fence, collected on the next frame, so the main thread never waits for the GPU. Averaging in linear light matters. On a frame where a quarter of the pixels are white:

| Downscaling | Measured mean luminance (true value 0.25) |
|---|---|
| v1.0 point sampling | 0.000 (the white pixels were skipped entirely) |
| Mipmaps in sRGB space | 0.051 |
| **Mipmaps in linear light (sRGB texture)** | **0.251** |

One WebGL context is shared by everything in a frame. Each video's GPU texture is freed when the video pauses, and the context itself is released 20 seconds after nothing needs it, so pages keep their own memory and context budget. If WebGL is unavailable or software-rendered, or the context is lost, NeuroShield falls back to the 2D path. The end-to-end tests run against both.

Canvases are read through `canvas.captureStream()` and `MediaStreamTrackProcessor`. That delivers exactly the frames the canvas presents, including WebGL canvases, whose drawing buffer can read back empty between frames. It delivers nothing while the canvas is still.

CSS and Web Animations that repeat quickly and change color, opacity, visibility or filters are sampled from computed style, composited against the background behind them. Because they're periodic, two cycles are enough: after that NeuroShield either pauses them or stops watching.

### Measured cost

`npm run bench` plays a 1080p60 video and reads Chrome's main-thread script time:

| Build | Script time per second of playback | Frames analyzed per second |
|---|---|---|
| 1.0.0 | 74–80 ms | ~12 |
| 1.1.0 | 42–46 ms | 60 |

## 3. Protecting

When a guard detects flashing, it:

1. blacks the element out with an inline `filter: brightness(0) !important` (canvases get `opacity(0)`, because transparent areas would otherwise still flash). Animations are paused instead. An inline filter on the element itself can't drift out of place while scrolling, and a `MutationObserver` puts it back if the page rewrites the `style` attribute;
2. pauses the video (unless you turned that off) and leaves picture-in-picture;
3. shows a card in the browser's top layer (Popover API), inside a closed shadow root. The top layer sits above fullscreen elements and any z-index, and the shadow root keeps page CSS out. While something is fullscreen, Chrome makes everything outside it inert, so the card is placed inside the fullscreen element. A fullscreen `<video>` can't hold children, so in that case NeuroShield leaves fullscreen;
4. ignores synthetic clicks, so a page can't press *Show anyway* for you.

*Show dimmed* applies `contrast(0.3) brightness(0.6) saturate(0.5)`. Measured in Chrome, black ↔ white through this filter swings 0.088 in relative luminance (under the 0.1 threshold), and pure red stops being a saturated red. *Show anyway* removes the filter and starts watching again 10 seconds later. A new video source (YouTube's next video in the same element, for instance) is always checked from scratch.

## 4. Limits

- **Detection is reactive.** It needs to see a few transitions: 7 at Medium. That takes roughly 0.25 s for a 12 Hz strobe and up to about a second just above 3 Hz.
- **Unreadable video.** Cross-origin video without CORS headers taints any canvas or texture it's drawn into, and DRM-protected video reads back black. No extension can analyze these. NeuroShield says so, and can dim them automatically (Settings → "Videos NeuroShield can't scan").
- **Not covered yet.** Animated GIF/WebP/APNG images (the browser only exposes their first frame), flashing created by scripts that change colors on regular elements, video drawn by plugins, and videos inside *closed* shadow roots attached to built-in elements such as `<div>` (closed roots on custom elements, where players live, are covered; checking every element would cost about 19 ms per 20,000 elements on every scan).
- **Animations are estimated.** NeuroShield reads computed styles, not pixels. When an animated element's own background is transparent, it assumes the content inside contrasts as much as possible with what's behind it. That errs toward hiding.
- **Area is approximate.** WCAG exempts flashes smaller than about a quarter of a 10° field of view (roughly 21,800 CSS px²). NeuroShield measures areas from regions of the frame, so a small but very bright flash can still fill enough of a region to count: it errs toward hiding.
- **Patterns.** Analysis averages each region, so a pattern whose light and dark parts swap places (a reversing checkerboard or grating) keeps the same average and isn't seen. Fast motion across a region can look like flashing, mostly at High and Maximum.

If NeuroShield misses something, please [report it](https://github.com/OMARVII/Neuroshield/issues/new?template=missed-flash.yml). Those reports turn into test fixtures.
