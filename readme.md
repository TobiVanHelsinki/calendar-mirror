# Calendar Mirror

![Calendar Mirror logo](addon/icons/calmirror.svg)

A Thunderbird add-on that mirrors events from one or more calendars **one-way** into another calendar.

Typical use: your work calendar lives in Exchange and is connected to Thunderbird via the
[Owl](https://addons.thunderbird.net/thunderbird/addon/owl-for-exchange/) add-on, but you want to see it on
your Android phone. Calendar Mirror copies the events into a Nextcloud calendar (CalDAV), which your phone
syncs with DAVx5.

Nothing is ever written back to the sources.

## Features

- Initial full sync, then follows created, updated and deleted events in the sources immediately
- Recurring events, including moved and cancelled occurrences
- Several source calendars into one target, with duplicate detection and source priority
- Configurable time range (default: 1 month back, 6 months ahead)
- Only touches its own copies in the target; other events there are left alone
- Adjustments for Exchange/Owl data (see below), each of which can be switched off
- Optional: puts the join link of Teams, Zoom, Webex & co. into the location, one tap away on your phone

## Requirements

- Thunderbird 128 to 156
- The add-on uses the draft [Calendar Experiment API](https://github.com/thunderbird/webext-experiments/tree/main/calendar).
  Experiments can break with Thunderbird updates, so each version of the add-on declares the highest
  Thunderbird version it has been tested with.

## Installation

1. Download `calmirror-<version>.xpi` from the
   [releases](https://github.com/tobivanhelsinki/calendar-mirror/releases) (or build it, see [Development](#development)).
2. In Thunderbird: Add-ons Manager → gear icon → *Install Add-on From File…*

## Setup

1. Create a separate, empty calendar for the mirror, e.g. a new Nextcloud calendar.
2. In its calendar properties, turn off *Show Reminders*. Otherwise Thunderbird shows every reminder twice
   (original and copy). Your phone still shows them.
3. Open the add-on's options (Add-ons Manager → Calendar Mirror → Options), choose the source calendars and
   the target, and save.

The options page shows the result of the last sync.

## How it works

- Every copy gets its own UID `calmirror-<hash>`, derived from the source calendar and the source UID, plus
  the fields `X-MIRROR-SOURCE-UID`, `X-MIRROR-SOURCE-CALENDAR` and `X-MIRROR-HASH`.
- A copy is only rewritten if its sanitized content actually changed (compared via the hash).
- The mirror only changes or deletes events with a `calmirror-` UID in the target.
- Events with at least one occurrence in the time range are mirrored; recurring events as a whole.
  Copies that fall out of the range are deleted.
- **Duplicates:** two occurrences count as the same if title (ignoring case) and start match. Occurrences
  already provided by a higher-priority source are excluded from the copy (`EXDATE`); if all occurrences
  are covered, the event is not mirrored at all.
- **Startup:** some calendars (e.g. Owl) need a minute or two after Thunderbird starts until all events are
  loaded. During a grace period (default: 5 minutes) nothing is deleted in the target, only created and
  updated. The same applies to a source that returns no events at all.

### Adjustments to the copies

Based on observations with Exchange via Owl. All of them are enabled by default except the meeting link and
can be switched off in the options.

| Adjustment | Why |
| --- | --- |
| Remove organizer and attendees | Otherwise servers treat the copy as an invitation and may email attendees |
| Plain text description only | Exchange adds a large HTML version (ALTREP) |
| Remove vendor fields (`X-MICROSOFT-*`, `X-MOZ-*`, `RELATED-TO`) | Useless or misleading in the copy |
| Time zones without a definition are treated as UTC | Owl delivers UTC times labeled e.g. “(UTC+01:00) Amsterdam, Berlin, …” |
| Windows time zone names become IANA names | “W. Europe Standard Time” → `Europe/Berlin`, known to Nextcloud and Android |
| Join link into the location (off by default) | Heuristic for Teams, Zoom, Webex, Google Meet, Jitsi, DFNconf, GoTo |

Always applied: `DTSTAMP`, `LAST-MODIFIED` and `CREATED` are dropped (Owl rewrites them on every sync),
and an invalid `TRANSP:unset` becomes `OPAQUE`.

## Known limitations

- Only events are mirrored, no tasks.
- Duplicate detection is an approximation: slightly different titles stay duplicates, and two different
  events with the same title and start are merged.
- Only a few Windows time zone names are mapped so far (Central/Western Europe, UK).
- When you switch to another target calendar, the copies in the previous target stay there.

## Privacy

The add-on itself sends no data anywhere. Events only leave your computer through the target calendar you
choose (e.g. to your Nextcloud server).

## Troubleshooting

Please report problems as a [GitHub issue](https://github.com/tobivanhelsinki/calendar-mirror/issues).
All log lines of the add-on start with `[calmirror]`. See them in Thunderbird via
*Tools → Developer Tools → Error Console*, or in the log files described under [Development](#development).

## Development

The add-on lives in `addon/`. `experiments/calendar/` is an unmodified copy of the Calendar Experiment from
[webext-experiments](https://github.com/thunderbird/webext-experiments) (MPL-2.0); do not edit it.

- **Test:** Thunderbird → *Debug Add-ons* → *Load Temporary Add-on…* → `addon/manifest.json`
- **Build:** `pwsh ./build.ps1` creates `dist/calmirror-<version>.xpi`
- **Release:** bump `version` in `addon/manifest.json`, add an entry to [`addon/CHANGELOG.md`](addon/CHANGELOG.md),
  check `strict_max_version` against the tested Thunderbird version, build

### Logs to files (Windows)

With `devtools.console.stdout.chrome` and `devtools.console.stdout.content` set to `true`, start Thunderbird
like this (close it completely first, including the tray icon):

    Start-Process "C:\Program Files\Mozilla Thunderbird\thunderbird.exe" -ArgumentList "-wait-for-browser" -RedirectStandardOutput "$env:TEMP\tb-out.log" -RedirectStandardError "$env:TEMP\tb-err.log" -Wait

Console output then ends up in `%TEMP%\tb-out.log` and `%TEMP%\tb-err.log`.

## License

The Calendar Experiment in `addon/experiments/` is licensed under the
[Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/). License for the rest of the add-on: to be
decided.
