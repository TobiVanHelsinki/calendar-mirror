# Changelog

## 0.1.0 – 2026-09-23

- First version: one-way mirror of one or more calendars into a target calendar
- Initial full sync, then follows created, updated and deleted events immediately; periodic full sync
- Recurring events including moved and cancelled occurrences
- Only copies created by the mirror (UID `calmirror-…`) are ever changed or deleted in the target
- Duplicate detection across sources per occurrence (same title and start), with source priority
- Configurable time range; copies that fall out of the range are deleted
- No deleting during a grace period after Thunderbird starts, while sources are still loading
- Adjustments for Exchange/Owl: remove attendees, plain text description, remove vendor fields, fix time zones
- Optional: put the join link of online meetings into the location
- Options page with sync status and "Sync now"
