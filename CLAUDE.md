# CLAUDE.md – Calendar Mirror

Notes for AI assistants continuing work on this project. `readme.md` is the user-facing documentation;
this file records context, decisions and hard-won knowledge that is not obvious from the code.

## Working with the user

- **Chat in German, all artifacts in English** (code, comments, logs, UI strings, docs, scripts). The user
  runs Thunderbird and most software in English.
- The user **loads/reloads the add-on manually** in Thunderbird and then says "reload komplett" / "done".
  After that, read the logs yourself (see below) instead of asking for them.
- Thunderbird usually keeps running; do not ask the user to close it. The log file is locked, so read it
  with shared access (see "Logs").
- **Keep shell commands simple.** The user wants to click "always allow" on commands; long chained
  `cd … && find … | xargs …` pipelines were rejected. Prefer the Grep/Read/Glob tools, and put anything
  complex into a small script file in the scratchpad and run that.
- Environment: Windows 11, Thunderbird 156 (release channel, not ESR), VS Code, PowerShell 7, Python 3.10
  available (`python`), **no Node.js**. Headless Edge works for rendering previews
  (`msedge --headless --screenshot=… file.html`).
- The user values honesty about assumptions: heuristics must be explained on the options page and be
  switchable. New optional behavior defaults to **off** unless agreed otherwise (e.g. meeting link).
- Git: local repository on branch `main`, no remote yet – the user pushes after a long-term test. Planned
  remote: `github.com/tobivanhelsinki/calendar-mirror`. The repo has a **local** identity
  (`TobiVanHelsinki <tobivanhelsinki@t-imperium.de>`); the global git config belongs to a private GitLab and
  must not be used here or changed. `dist/` is ignored; XPIs go to GitHub releases. Commit only when asked.
- The local folder is still named `calendermirror`; the user will rename it later.

## Goal and setup

One-way mirror of Thunderbird calendars into another calendar. The user's real case: two Exchange calendars
connected via the **Owl** add-on (calendar type `owl`) → a dedicated **Nextcloud** CalDAV calendar → Android
via DAVx5. Development/testing so far used a local calendar "tmp" as target; the user is deleting "tmp" and
switching to a Nextcloud target for the long-term test.

The user has three Thunderbird profiles; the active one is `…\Profiles\iji3w9bo.work`.

## Repository layout

```text
addon/                    the add-on (load addon/manifest.json as temporary add-on)
  manifest.json           MV2, id calendar-mirror@tobivanhelsinki.github.io, strict_max_version 156.*
  settings.js             DEFAULT_SETTINGS, loadSettings/saveSettings (storage.local key "settings")
  mirror-ical.js          line-based iCal sanitizing, dedupe helpers, hashing (no full parser)
  background.js           sync engine, event listeners, scheduling, status (storage.local key "status")
  options/                options page (open_in_tab), shows status, "Sync now", About + changelog
  CHANGELOG.md            shown on the options page; also the release notes
  icons/calmirror.svg     logo (calendar + mirrored copy + one-way arrow)
  experiments/calendar/   UNMODIFIED copy of the Calendar Experiment (MPL-2.0) – never edit
build.ps1                 packs addon/ into dist/calmirror-<version>.xpi (uses "/" paths, not Compress-Archive)
readme.md                 user-facing README (planned GitHub README / ATN description)
```

## Calendar Experiment API

- Source: <https://github.com/thunderbird/webext-experiments/tree/main/calendar> (draft). AI guidance:
  <https://github.com/thunderbird/webext-support> (`ai/`). Guidance says: copy `experiments/calendar/`
  unmodified and add **all** `experiment_apis` entries from the upstream manifest.
- The `calendar_provider` experiment must stay: its `onStartup` registers the `resource://` substitution
  that the other experiment scripts import `ext-calendar-utils.sys.mjs` from. It works without a
  `calendar_provider` manifest key.
- Upstream already contains fixes for TB ≥ 148 (`createCalendarObserver`). Works on TB 156.
- Experiment APIs (parent scope) are available on the options page too.
- **Range queries miss series:** `items.query({rangeStart, rangeEnd})` without `expand` only returns a
  recurring event if its *first* occurrence is in the range. Therefore `querySourceItems` queries with
  `expand: true` (occurrences), collects the IDs and fetches each main event via `items.get(…, {returnFormat:
  "ical"})`, which includes all exception VEVENTs.
- `items.create/update` with `format: "ical"` accepts a VCALENDAR with one parent VEVENT plus exception
  VEVENTs (same UID, `RECURRENCE-ID`). `props.id` is ignored; the UID comes from the iCal.
- `items.onCreated/onUpdated/onRemoved` fire for all calendars; filter by `calendarId`. Owl fires many
  `onUpdated` during its refresh → debounced (5 s) full sync.
- `runtime.onStartup` fires only on Thunderbird start, not when the add-on is (re)loaded at runtime. Used to
  apply the startup grace period only on real startups.

## Owl / Exchange data quirks (observed, verified with real data)

- `LAST-MODIFIED` and `DTSTAMP` are rewritten by Owl on every refresh → useless for change detection.
  The mirror compares a SHA-256 hash of the sanitized content instead (`X-MIRROR-HASH`, 16 hex chars).
- Owl needs **1–2 minutes after Thunderbird start** to load a calendar completely. A partially loaded
  source would cause deletions + re-creations → deletions are suspended for `startupGraceMinutes`
  (default 5) after app start, and never happen for a source that returns zero events.
- **Empty VTIMEZONE = UTC.** Owl emits TZIDs such as `tzone://Microsoft/Utc` or
  `(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna` with an empty VTIMEZONE (no
  STANDARD/DAYLIGHT). The values are actually UTC (verified: a 13:00 Berlin meeting appears as 11:00 in
  summer and 12:00 in winter). Thunderbird displays them as UTC too. An earlier attempt to map the Windows
  display name to `Europe/Berlin` produced wrong times – don't repeat it.
- **Windows zone names with a real definition** (e.g. `W. Europe Standard Time`) are shown correctly by
  Thunderbird; the mirror maps them to IANA (`WINDOWS_TZ_TO_IANA`) for Nextcloud/Android. The user
  verified the resulting time (DEMO-Tour at 10:00).
- `TRANSP:unset` is invalid → becomes `OPAQUE`.
- Descriptions come as plain text plus a huge HTML `ALTREP="data:text/html,…"`. Join links are sometimes
  only in the HTML version.
- Lots of `X-MICROSOFT-*` (Teams IDs etc.), `X-MOZ-*`, `RELATED-TO`.
- The same meeting often exists in **both** Owl calendars with **different UIDs**, and series can have
  different start/end dates per mailbox (invited later, series split by Exchange). Hence dedupe per
  occurrence, not per series.
- Thunderbird's local calendar data is in `calendar-data\local.sqlite` (local calendars) and
  `cache.sqlite` (offline cache, incl. Owl). Tables `cal_events`, `cal_properties`, `cal_parameters`
  (ALTREP lives here, `key1='DESCRIPTION', key2='ALTREP'`), `cal_recurrence`. Open **read-only**
  (`file:…?mode=ro`, `uri=True`) for verification scripts; never write.

## Sync design (background.js)

- Copy UID: `calmirror-` + first 32 hex chars of SHA-256(`sourceCalendarId + "/" + sourceUid`). Stable, so
  copies survive add-on ID changes and reinstalls.
- Copies carry `X-MIRROR-SOURCE-UID`, `X-MIRROR-SOURCE-CALENDAR`, `X-MIRROR-HASH`. Only items whose ID starts
  with `calmirror-` are ever touched in the target.
- Full sync: read all copies in the target (no range, so copies outside the window get deleted), process
  sources in priority order, create/update when the hash differs, then delete unwanted copies – except
  during the grace period or for "incomplete" sources (missing, unreadable, zero events).
- Update falls back to remove + create if `items.update` fails.
- On errors for a single item, its existing copy is kept (added to `wanted`).
- Only one sync at a time; requests during a sync queue exactly one follow-up. Triggers: startup (2 s after
  load), debounced item events, interval (`resyncMinutes`), settings change, "Sync now" message.
- **Dedupe** (`settings.dedupe`): key = lowercased, whitespace-normalized SUMMARY + DTSTART converted to UTC
  (`comparableTime`, uses `Intl` for IANA zones plus `WINDOWS_TZ_TO_IANA`). Occurrences are sanitized first
  so the UTC fixes apply. If all occurrences of an event are already covered → skip the event; if some are →
  `excludeOccurrences` adds `EXDATE`s and removes matching exception VEVENTs. Log messages for duplicates are
  reported once per session (`reportedDuplicates`).
- Status of the last sync is written to `storage.local.status` and shown live on the options page.

## Sanitizing (mirror-ical.js)

Works on unfolded lines with a simple property parser (handles quoted params). Always: replace UID, drop
`DTSTAMP`/`LAST-MODIFIED`/`CREATED`, fix `TRANSP`. Switchable via `settings.transform`:
`removeAttendees` (METHOD/ORGANIZER/ATTENDEE), `mirrorDescription`, `removeHtmlDescription` (ALTREP),
`mirrorAlarms` (drops VALARM blocks), `removeVendorFields`, `meetingLinkInLocation` (default off),
`emptyTimezonesAsUtc`, `mapWindowsTimezones`. Adding a transform key requires: default in `settings.js`,
checkbox `t-<key>` in `options.html` (options.js picks up keys automatically), README table.

Meeting link heuristic: patterns for Teams, Zoom (incl. Zoom X `zoom-x.de`), Webex, Google Meet, Jitsi
(incl. self-hosted), DFNconf, GoTo; searched in DESCRIPTION, decoded ALTREP HTML, LOCATION, URL and
`*MEETING*` properties. Generic locations ("Microsoft Teams-Besprechung", "Online", …) are replaced by the
link, real locations get " | link" appended. Measured on the user's data: link found for ~95 % of online
meetings (885 of 930 candidates, the rest mostly false candidates).

## Logs and verification

- Thunderbird is started with stdout/stderr redirected; logs are `%TEMP%\tb-out.log` and
  `%TEMP%\tb-err.log` (start command in readme.md). All add-on lines start with `[calmirror]`.
- Useful: Grep `calmirror\]" "(Sync|Warning|Failed|Duplicate|Partial)` with an `offset` to see only new
  lines; very long lines (iCal dumps) need Grep `-o` with `^.{0,300}`, or a script that opens the file with
  `FileShare.ReadWrite` (Thunderbird holds a lock).
- "Sync finished: …" summarizes counts; after a reload, a clean state shows everything "unchanged".

## Release process

Bump `version` in `addon/manifest.json`, add a `CHANGELOG.md` entry, test on the current Thunderbird, bump
`strict_max_version` when a new Thunderbird major version was tested (the user deliberately uses a max
version to practice the published-add-on workflow; TB 157 will disable the add-on until bumped), run
`pwsh ./build.ps1`. Install via Add-ons Manager → gear → Install Add-on From File. Unsigned XPIs work in
Thunderbird.

The Add-ons Manager details page of a file-installed add-on only shows manifest fields (name, description,
version, author, homepage_url); long description and release notes come from addons.thunderbird.net after
publishing. That is why version + changelog are shown in the "About" section of the options page.

## Open items

- Long-term test with a Nextcloud target, then check on Android (DAVx5): times (UTC and Windows-zone
  cases), series with exceptions/EXDATEs, reminders, whether Nextcloud accepts all copies via CalDAV
  (updates to existing items not tested against CalDAV yet).
- Startup grace period only testable with the installed XPI (temporary add-ons vanish on restart).
- Before pushing to GitHub: decide the license for the add-on's own code (MPL-2.0 suggested, matching the
  experiment; MIT possible), add a `LICENSE` file and update README "License".
- Possible later ideas mentioned but not decided: localization (`_locales`, en + de), more Windows time zone
  mappings, a smaller 16 px icon variant, cleanup of copies in a previous target after switching targets,
  mirroring tasks.
