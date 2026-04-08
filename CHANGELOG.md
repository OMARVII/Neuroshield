# Changelog

All notable changes to NeuroShield will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-03-21

### Added

- Real-time flash detection using WCAG 2.3.1 luminance thresholds with sRGB linearization
- Works on every website via Chrome content scripts
- Warning overlay with dim, pause, and continue controls
- Protective CSS filter fallback for cross-origin videos
- Four sensitivity levels: low (5 Hz), medium (3 Hz, WCAG default), high (2 Hz), maximum (1 Hz)
- Accessible overlay with ARIA roles, keyboard navigation, and screen reader support
- Resilient architecture: survives extension updates and service worker restarts
- 65 unit tests covering the full detection pipeline
- ESLint configuration for code quality
- Privacy policy (zero data collection)
