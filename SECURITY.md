# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in NeuroShield, **please don't open a public issue.**

Email **omarkhaledvii@gmail.com** with:

- a description of the vulnerability,
- steps to reproduce,
- the impact you expect.

You'll get a response within 72 hours. Issues that affect user safety are handled first.

## Scope

NeuroShield runs locally and makes no network requests. The concerns that matter most are:

- **Bypassing protection.** A page that can stop NeuroShield from hiding flashing content (for example by tricking detection, removing the protective filter, or pressing "Show anyway" from script) puts photosensitive users at risk. These reports are treated as high severity.
- Script injection or XSS through NeuroShield's on-page UI, popup or settings page.
- Permission escalation through the extension.

Missed detections that aren't caused by a page deliberately working around NeuroShield are welcome as [regular issues](https://github.com/OMARVII/Neuroshield/issues/new?template=missed-flash.yml).

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x | Yes |
| 1.0.x | No. Please update; 1.0 misses some flash patterns. |
