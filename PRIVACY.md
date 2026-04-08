# Privacy Policy — NeuroShield

**Last updated:** April 2026

## Data Collection

NeuroShield does not collect, transmit, or store any personal data. Period.

## How It Works

All visual analysis runs **entirely within your browser**. Video frames are sampled into a tiny offscreen canvas (32x32 pixels) for luminance computation. This data exists only in memory for the duration of analysis and is never saved, logged, or sent anywhere.

## What We Store

NeuroShield stores only your extension preferences (enabled/disabled state and sensitivity level) using Chrome's local storage API (`chrome.storage.local`). This data never leaves your device and is not synced to any cloud service.

## Network Requests

NeuroShield makes **zero network requests**. It does not phone home, check for updates independently, send telemetry, or communicate with any external server.

## Permissions

- **storage**: Saves your sensitivity preferences locally on your device.
- **Content script access (all URLs)**: Required to inject the flash detection engine into webpages. The content script only analyzes visual luminance of media elements — it does not read page content, form data, cookies, or any personally identifiable information.

## Third Parties

NeuroShield shares no data with any third party because it collects no data.

## Changes

If this policy changes, the update will be published in the repository and noted in the extension changelog.

## Contact

Open an issue on the GitHub repository for any privacy concerns.
