# Privacy Policy — NeuroShield

**Last updated:** October 2026

## In short

NeuroShield does not collect, transmit or sell any data. It makes no network requests. Everything it does happens inside your browser.

## How it works

To find flashing content, NeuroShield reads the frames of videos, canvases and animations on the pages you visit. Each frame is reduced to a 32×32 grid of brightness samples in memory, analyzed, and discarded. Frames are never saved, logged or sent anywhere. NeuroShield does not read page text, form data, cookies, passwords or browsing history.

## What is stored, and where

| Data | Where | How long |
|---|---|---|
| Your settings (on/off, sensitivity, pause-video and unscannable-video choices) | `chrome.storage.local`, on this device only, not synced | Until you change them or remove NeuroShield |
| Sites where you paused protection (hostnames you chose) | `chrome.storage.local`, on this device only | Until you resume them or remove NeuroShield |
| A count of how many times flashing was hidden | `chrome.storage.local`, on this device only | Until you reset it (Settings → Activity) or remove NeuroShield |
| Per-tab state shown in the popup and toolbar button (the hostname of the page, videos watched, flashes hidden on it) | `chrome.storage.session`, in memory | Cleared when the tab closes or the browser quits |

## Network requests

None. NeuroShield does not contact any server, check for updates by itself (Chrome handles updates), send telemetry, or load remote code.

## Permissions

- **Read and change data on all websites** (content scripts and host access): needed to run the flash detector on every page and frame, and to start protection in tabs that were already open when NeuroShield was installed or updated. It is used only to analyze visual content and to hide or pause flashing elements.
- **storage**: saves your settings on your device.
- **scripting**: starts protection in tabs that were open before installation, without a reload.

## Third parties

NeuroShield shares nothing with anyone, because it collects nothing.

## Changes

Changes to this policy are published in the repository and noted in the changelog.

## Contact

Open an issue on [GitHub](https://github.com/OMARVII/Neuroshield/issues), or email omarkhaledvii@gmail.com.
