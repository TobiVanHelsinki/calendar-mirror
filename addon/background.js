// Calendar Mirror: one-way mirror of one or more source calendars into a target calendar.
// Settings live in settings.js, iCal helpers in mirror-ical.js.

var { calendar: lightning } = messenger;

// Owl reports many changes at once while refreshing, so batch them into one sync
const DEBOUNCE_SECONDS = 5;

let settings = DEFAULT_SETTINGS;

// Time Thunderbird was started (null if the add-on was loaded while Thunderbird was running). Until the
// startup grace period has passed, nothing is deleted in the target because sources may still be incomplete.
let appStartedAt = null;

function deletionsAllowedAt() {
  return appStartedAt ? appStartedAt + settings.startupGraceMinutes * 60 * 1000 : 0;
}

// Duplicates already reported, so the log does not repeat them on every sync
const reportedDuplicates = new Set();

const PREFIX = "[calmirror]";

function log(...args) {
  console.log(PREFIX, ...args);
}

function logError(...args) {
  console.error(PREFIX, ...args);
}

function errorText(e) {
  return e?.message ?? String(e);
}

// Result of the last sync, shown on the options page
async function setStatus(ok, text) {
  await messenger.storage.local.set({ status: { time: Date.now(), ok, text } });
}

// JS Date -> iCal date in UTC, e.g. 20260923T120000Z
function icalDate(date) {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/[:-]/g, "");
}

function syncWindow() {
  const start = new Date();
  start.setMonth(start.getMonth() - settings.monthsBack);
  const end = new Date();
  end.setMonth(end.getMonth() + settings.monthsAhead);
  return { rangeStart: icalDate(start), rangeEnd: icalDate(end) };
}

// The UID of the copy depends on the source calendar and the source UID
async function mirrorUidFor(sourceCalendarId, sourceUid) {
  const hash = await sha256Hex(sourceCalendarId + "/" + sourceUid);
  return MIRROR_UID_PREFIX + hash.slice(0, 32);
}

// Sanitizes the source event; excludedRecurrenceIds: occurrences already provided by a higher-priority source
async function buildMirrorItem(sourceItem, mirror, excludedRecurrenceIds) {
  let { text, warnings } = sanitizeIcal(sourceItem.item, mirror, settings.transform);
  if (excludedRecurrenceIds.length) {
    text = excludeOccurrences(text, excludedRecurrenceIds);
  }
  const hash = (await sha256Hex(text)).slice(0, 16);
  return { ical: addMirrorHash(text, hash), hash, warnings };
}

async function writeMirrorItem(targetId, mirrorUid, ical, exists) {
  if (!exists) {
    await lightning.items.create(targetId, { type: "event", format: "ical", item: ical });
    return;
  }
  try {
    await lightning.items.update(targetId, mirrorUid, { format: "ical", item: ical });
  } catch (e) {
    log(`Updating ${mirrorUid} failed (${errorText(e)}), recreating it`);
    await lightning.items.remove(targetId, mirrorUid);
    await lightning.items.create(targetId, { type: "event", format: "ical", item: ical });
  }
}

// All events of a source with at least one occurrence in the sync window, as iCal, plus the occurrences
// in the window per event (occurrenceInfo). With a range, Thunderbird only returns a series if its first
// occurrence is in the range. So query the occurrences and fetch the main events one by one.
async function querySourceItems(calendarId, rangeStart, rangeEnd) {
  const occurrences = await lightning.items.query({
    calendarId,
    type: "event",
    rangeStart,
    rangeEnd,
    expand: true,
    returnFormat: "ical",
  });

  const occurrencesById = new Map();
  for (const occurrence of occurrences) {
    const mirror = { uid: occurrence.id, sourceCalendarId: calendarId };
    const { text } = sanitizeIcal(occurrence.item, mirror, settings.transform);
    if (!occurrencesById.has(occurrence.id)) {
      occurrencesById.set(occurrence.id, []);
    }
    occurrencesById.get(occurrence.id).push(occurrenceInfo(text));
  }

  const items = [];
  for (const id of occurrencesById.keys()) {
    const item = await lightning.items.get(calendarId, id, { returnFormat: "ical" });
    if (item) {
      items.push(item);
    }
  }
  return { items, occurrencesById };
}

// Returns the target and the sources; a missing source does not abort the sync (calendar = null)
async function checkCalendars() {
  const { sourceCalendarIds, targetCalendarId } = settings;
  if (sourceCalendarIds.includes(targetCalendarId)) {
    throw new Error("The target calendar is also selected as a source");
  }
  const target = await lightning.calendars.get(targetCalendarId);
  if (!target) {
    throw new Error(`Target calendar ${targetCalendarId} not found`);
  }
  if (target.readOnly) {
    throw new Error(`Target calendar "${target.name}" is read-only`);
  }
  const sources = [];
  for (const id of sourceCalendarIds) {
    const calendar = await lightning.calendars.get(id);
    if (!calendar) {
      logError(`Source calendar ${id} not found, skipping it`);
    }
    sources.push({ id, calendar });
  }
  return { sources, target };
}

async function fullSync(reason) {
  if (!settings.targetCalendarId || settings.sourceCalendarIds.length == 0) {
    log("Not configured: choose sources and a target in the options");
    await setStatus(false, "Not configured: please choose sources and a target.");
    return;
  }

  const { sources, target } = await checkCalendars();
  const { rangeStart, rangeEnd } = syncWindow();
  const sourceNames = sources.filter(s => s.calendar).map(s => `"${s.calendar.name}"`).join(", ");
  log(`Sync (${reason}): ${sourceNames} -> "${target.name}", ${rangeStart} to ${rangeEnd}`);

  // All copies in the target, including those outside the window, so that copies that fell out get deleted
  const targetItems = await lightning.items.query({
    calendarId: target.id,
    type: "event",
    returnFormat: "ical",
  });
  const existing = new Map(
    targetItems.filter(item => item.id.startsWith(MIRROR_UID_PREFIX)).map(item => [item.id, item])
  );

  const stats = {
    source: 0, created: 0, updated: 0, unchanged: 0, duplicates: 0, partial: 0, removed: 0, kept: 0, failed: 0,
  };
  const wanted = new Set();
  const incompleteSources = new Set(); // sources whose copies must not be deleted
  const seenOccurrences = new Map(); // title + start of an occurrence -> name of the source that provides it

  for (const { id: sourceId, calendar: source } of sources) {
    if (!source) {
      incompleteSources.add(sourceId);
      continue;
    }

    let sourceItems;
    let occurrencesById;
    try {
      ({ items: sourceItems, occurrencesById } = await querySourceItems(sourceId, rangeStart, rangeEnd));
    } catch (e) {
      logError(`Cannot read events from "${source.name}": ${errorText(e)}`);
      incompleteSources.add(sourceId);
      continue;
    }
    if (sourceItems.length == 0) {
      log(`"${source.name}" returned no events, its copies are left untouched`);
      incompleteSources.add(sourceId);
    }
    stats.source += sourceItems.length;

    for (const sourceItem of sourceItems) {
      let mirrorUid;
      try {
        mirrorUid = await mirrorUidFor(sourceId, sourceItem.id);
        if (wanted.has(mirrorUid)) {
          continue;
        }
        const summary = readSummary(sourceItem.item);

        // Occurrences already provided by a higher-priority source (or an earlier event)
        const occurrences = occurrencesById.get(sourceItem.id) ?? [];
        const covered = settings.dedupe ? occurrences.filter(occ => seenOccurrences.has(occ.key)) : [];
        const reportKey = `${sourceId}|${sourceItem.id}|${covered.length}`;
        const firstSource = covered.length ? seenOccurrences.get(covered[0].key) : null;

        if (occurrences.length && covered.length == occurrences.length) {
          stats.duplicates++;
          if (!reportedDuplicates.has(reportKey)) {
            reportedDuplicates.add(reportKey);
            log(`Duplicate: skipped "${summary}" from "${source.name}", already provided by "${firstSource}"`);
          }
          continue;
        }
        const excludedRecurrenceIds = covered.map(occ => occ.recurrenceId).filter(Boolean);
        if (excludedRecurrenceIds.length) {
          stats.partial++;
          if (!reportedDuplicates.has(reportKey)) {
            reportedDuplicates.add(reportKey);
            log(
              `Partial duplicate: "${summary}" from "${source.name}", excluded ${excludedRecurrenceIds.length} of ` +
              `${occurrences.length} occurrences already provided by "${firstSource}"`
            );
          }
        }
        for (const occ of occurrences) {
          if (!seenOccurrences.has(occ.key)) {
            seenOccurrences.set(occ.key, source.name);
          }
        }
        wanted.add(mirrorUid);

        const { ical, hash, warnings } = await buildMirrorItem(
          sourceItem,
          { uid: mirrorUid, sourceCalendarId: sourceId },
          excludedRecurrenceIds
        );
        for (const warning of new Set(warnings)) {
          log(`Warning for "${summary}": ${warning}`);
        }

        const old = existing.get(mirrorUid);
        if (old && readMirrorHash(old.item) == hash) {
          stats.unchanged++;
          continue;
        }
        await writeMirrorItem(target.id, mirrorUid, ical, !!old);
        stats[old ? "updated" : "created"]++;
      } catch (e) {
        stats.failed++;
        // On errors, rather keep the existing copy than delete it
        if (mirrorUid) {
          wanted.add(mirrorUid);
        }
        logError(`Failed to mirror "${sourceItem.id}" from "${source.name}": ${errorText(e)}`);
      }
    }
  }

  // Safety: while the sources may still be incomplete, nothing is deleted in the target
  if (Date.now() < deletionsAllowedAt()) {
    const until = new Date(deletionsAllowedAt()).toLocaleTimeString();
    log(`Deleting suspended until ${until}, sources may still be loading`);
  } else {
    for (const [mirrorUid, item] of existing) {
      if (wanted.has(mirrorUid)) {
        continue;
      }
      if (incompleteSources.has(readMirrorSourceCalendar(item.item))) {
        stats.kept++;
        continue;
      }
      try {
        await lightning.items.remove(target.id, mirrorUid);
        stats.removed++;
      } catch (e) {
        stats.failed++;
        logError(`Failed to delete ${mirrorUid}: ${errorText(e)}`);
      }
    }
  }

  const summary =
    `${stats.source} events in sources, ${stats.created} created, ${stats.updated} updated, ` +
    `${stats.unchanged} unchanged, ${stats.duplicates} duplicates, ${stats.partial} partial duplicates, ` +
    `${stats.removed} deleted, ${stats.kept} kept, ${stats.failed} errors`;
  log(`Sync finished: ${summary}`);
  await setStatus(stats.failed == 0, summary);
}

// Only one sync runs at a time; requests during a sync trigger exactly one more
let syncRunning = false;
let syncPending = null;

async function requestSync(reason) {
  if (syncRunning) {
    syncPending = reason;
    return;
  }
  syncRunning = true;
  try {
    let next = reason;
    while (next) {
      syncPending = null;
      try {
        await fullSync(next);
      } catch (e) {
        logError(`Sync failed: ${errorText(e)}`);
        await setStatus(false, `Sync failed: ${errorText(e)}`);
      }
      next = syncPending;
    }
  } finally {
    syncRunning = false;
  }
}

let debounceTimer = null;

function scheduleSync(reason) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => requestSync(reason), DEBOUNCE_SECONDS * 1000);
}

let intervalTimer = null;

function restartInterval() {
  clearInterval(intervalTimer);
  intervalTimer = setInterval(() => requestSync("interval"), settings.resyncMinutes * 60 * 1000);
}

function isSource(calendarId) {
  return settings.sourceCalendarIds.includes(calendarId);
}

lightning.items.onCreated.addListener(item => {
  if (isSource(item.calendarId)) {
    scheduleSync("event created");
  }
});
lightning.items.onUpdated.addListener(item => {
  if (isSource(item.calendarId)) {
    scheduleSync("event updated");
  }
});
lightning.items.onRemoved.addListener(calendarId => {
  if (isSource(calendarId)) {
    scheduleSync("event deleted");
  }
});

// Fires only when Thunderbird starts, not when the add-on is (re)loaded while Thunderbird is running
messenger.runtime.onStartup.addListener(() => {
  appStartedAt = Date.now();
  log("Thunderbird started: deleting suspended for now");
});

// Apply changed settings and sync right away
messenger.storage.onChanged.addListener(async (changes, area) => {
  if (area != "local" || !changes.settings) {
    return;
  }
  settings = await loadSettings();
  reportedDuplicates.clear();
  restartInterval();
  requestSync("settings changed");
});

// "Sync now" on the options page
messenger.runtime.onMessage.addListener(message => {
  if (message?.type == "syncNow") {
    return requestSync("manual");
  }
  return undefined;
});

async function init() {
  settings = await loadSettings();
  log("Calendar Mirror started");
  restartInterval();

  // Wait briefly so that onStartup has fired if applicable. On app startup, only create/update at first
  // (Owl's loading events trigger further syncs), then do a full sync once the grace period has passed.
  setTimeout(() => {
    if (Date.now() < deletionsAllowedAt()) {
      requestSync("startup, sources may still be loading");
      setTimeout(() => requestSync("startup, grace period over"), deletionsAllowedAt() - Date.now() + 1000);
    } else {
      requestSync("startup");
    }
  }, 2000);
}

init();
