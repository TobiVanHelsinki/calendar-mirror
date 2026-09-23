// Sanitizing of the source iCal text for the mirror copy.
// Works line by line on the unfolded iCal, without a full parser.

const MIRROR_UID_PREFIX = "calmirror-";

// Always removed: timestamps that Owl rewrites on every sync (otherwise every event would count as changed)
const ALWAYS_DROP = new Set(["DTSTAMP", "LAST-MODIFIED", "CREATED"]);
// Invitation data (setting removeAttendees)
const ATTENDEE_PROPERTIES = new Set(["METHOD", "ORGANIZER", "ATTENDEE"]);
// Vendor-specific fields and references to events of the source (setting removeVendorFields)
const VENDOR_PROPERTIES = new Set(["RELATED-TO"]);
const VENDOR_PREFIXES = ["X-MICROSOFT-", "X-MOZ-"];

// Date properties whose TZID may need to be converted
const DATE_PROPERTIES = new Set(["DTSTART", "DTEND", "DUE", "RECURRENCE-ID", "EXDATE", "RDATE"]);

function unfoldLines(text) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(line => line.length);
}

// "NAME;P1=a;P2="x:y":value" -> { name, params: ["P1=a", "P2=\"x:y\""], value }
function parseLine(line) {
  const match = line.match(/^[A-Za-z0-9-]+/);
  if (!match) {
    return null;
  }
  const name = match[0].toUpperCase();
  const params = [];
  let pos = name.length;

  while (line[pos] == ";") {
    let end = pos + 1;
    let inQuotes = false;
    while (end < line.length && (inQuotes || (line[end] != ";" && line[end] != ":"))) {
      if (line[end] == '"') {
        inQuotes = !inQuotes;
      }
      end++;
    }
    params.push(line.slice(pos + 1, end));
    pos = end;
  }

  if (line[pos] != ":") {
    return null;
  }
  return { name, params, value: line.slice(pos + 1) };
}

function formatLine({ name, params, value }) {
  return name + params.map(param => ";" + param).join("") + ":" + value;
}

function paramValue(params, key) {
  const param = params.find(p => p.toUpperCase().startsWith(key + "="));
  return param?.slice(key.length + 1).replace(/^"(.*)"$/, "$1");
}

function shouldDrop(name, transform) {
  return (
    ALWAYS_DROP.has(name) ||
    (transform.removeAttendees && ATTENDEE_PROPERTIES.has(name)) ||
    (transform.removeVendorFields &&
      (VENDOR_PROPERTIES.has(name) || VENDOR_PREFIXES.some(prefix => name.startsWith(prefix))))
  );
}

// Sanitizes a single property inside a VEVENT. Returns null if the property is dropped.
// component: the innermost component (VEVENT or e.g. VALARM)
function sanitizeProperty(prop, component, mirror, transform, utcTzids, warnings) {
  if (shouldDrop(prop.name, transform)) {
    return null;
  }

  switch (prop.name) {
    case "UID":
      return [
        formatLine({ name: "UID", params: [], value: mirror.uid }),
        formatLine({ name: "X-MIRROR-SOURCE-UID", params: [], value: prop.value }),
        formatLine({ name: "X-MIRROR-SOURCE-CALENDAR", params: [], value: mirror.sourceCalendarId }),
      ];
    case "DESCRIPTION":
      if (component != "VEVENT") {
        break; // e.g. the text of a reminder
      }
      if (!transform.mirrorDescription) {
        return null;
      }
      if (transform.removeHtmlDescription) {
        // Drop the HTML version (ALTREP as data: URL), keep the plain text
        prop.params = prop.params.filter(p => !p.toUpperCase().startsWith("ALTREP="));
      }
      break;
    case "TRANSP":
      if (prop.value != "OPAQUE" && prop.value != "TRANSPARENT") {
        prop.value = "OPAQUE";
      }
      break;
  }

  if (DATE_PROPERTIES.has(prop.name)) {
    const tzid = paramValue(prop.params, "TZID");
    const withoutTzid = prop.params.filter(p => !p.toUpperCase().startsWith("TZID="));
    if (tzid && utcTzids.has(tzid)) {
      prop.params = withoutTzid;
      if (prop.value.includes("T")) {
        prop.value = prop.value.split(",").map(v => (v.endsWith("Z") ? v : v + "Z")).join(",");
      }
    } else if (tzid && transform.mapWindowsTimezones && WINDOWS_TZ_TO_IANA[tzid]) {
      // Windows name with a real definition: replace with the IANA name that Nextcloud/Android also know
      prop.params = [...withoutTzid, "TZID=" + WINDOWS_TZ_TO_IANA[tzid]];
    } else if (tzid && (tzid.startsWith("tzone://") || !tzid.includes("/"))) {
      warnings.push(`Unknown time zone "${tzid}"`);
    }
  }

  return [formatLine(prop)];
}

// TZID from a "TZID:" line, without iCal escapes and quotes
function tzidFromLine(line) {
  return line.slice(5).replace(/\\([,;\\])/g, "$1").replace(/^"(.*)"$/, "$1");
}

// TZIDs whose VTIMEZONE contains no rules (STANDARD/DAYLIGHT). Owl delivers times like this that are
// actually UTC, e.g. with "tzone://Microsoft/Utc" or "(UTC+01:00) Amsterdam, Berlin, …".
function findUtcTimezones(lines) {
  const utcTzids = new Set();
  let tzid = null;
  let hasRules = false;
  for (const line of lines) {
    if (line == "BEGIN:VTIMEZONE") {
      tzid = null;
      hasRules = false;
    } else if (line.startsWith("TZID:")) {
      tzid = tzidFromLine(line);
    } else if (line == "BEGIN:STANDARD" || line == "BEGIN:DAYLIGHT") {
      hasRules = true;
    } else if (line == "END:VTIMEZONE" && tzid && !hasRules) {
      utcTzids.add(tzid);
    }
  }
  return utcTzids;
}

// iCal TEXT values: resolve or apply escapes
function unescapeText(value) {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function escapeText(value) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// Join links of known video conferencing services, preferred in this order
const URL_CHARS = "[^\\s<>\"'\\\\]";
const MEETING_LINK_PATTERNS = [
  `https://teams\\.microsoft\\.com/(?:l/meetup-join|meet)/${URL_CHARS}+`,
  `https://teams\\.live\\.com/meet/${URL_CHARS}+`,
  `https://[\\w.-]*(?:zoom\\.us|zoom-x\\.de)/(?:j|my|w)/${URL_CHARS}+`,
  `https://[\\w.-]*webex\\.com/${URL_CHARS}*?(?:j\\.php|meet/|join/)${URL_CHARS}*`,
  `https://meet\\.google\\.com/[a-z]+-[a-z]+-[a-z]+`,
  `https://(?:meet\\.jit\\.si|[\\w.-]*jitsi[\\w.-]*)/${URL_CHARS}+`,
  `https://[\\w.-]*conf\\.dfn\\.de/${URL_CHARS}+`,
  `https://(?:global\\.gotomeeting\\.com|meet\\.goto\\.com|app\\.goto\\.com)/${URL_CHARS}+`,
].map(pattern => new RegExp(pattern, "i"));

// Locations that only point to the online meeting and get replaced by the link (English and German)
const GENERIC_ONLINE_LOCATION =
  /^(microsoft teams[- ]?(besprechung|meeting)?|teams[- ]?(besprechung|meeting)|zoom([- ]?meeting)?|webex([- ]?meeting)?|google meet|jitsi|online([- ]?(besprechung|meeting|termin))?|virtuell|virtual|video ?(call|konferenz|conference))$/i;

// Finds the join link of an online meeting in a VEVENT block (unfolded lines)
function findMeetingLink(block) {
  const texts = [];
  for (const line of block) {
    const prop = parseLine(line);
    if (!prop) {
      continue;
    }
    if (["DESCRIPTION", "LOCATION", "URL"].includes(prop.name) || prop.name.includes("MEETING")) {
      texts.push(unescapeText(prop.value));
    }
    // HTML version of the description (ALTREP as data: URL); contains the link even if the plain text shortens it
    const altrep = prop.name == "DESCRIPTION" ? paramValue(prop.params, "ALTREP") : null;
    if (altrep?.startsWith("data:")) {
      try {
        texts.push(decodeURIComponent(altrep.slice(altrep.indexOf(",") + 1)).replace(/&amp;/g, "&"));
      } catch {
        // Invalid encoding: ignore the HTML version
      }
    }
  }
  const text = texts.join("\n");
  for (const pattern of MEETING_LINK_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[0].replace(/[.,;:)\]]+$/, "");
    }
  }
  return null;
}

// New LOCATION value (iCal-escaped) including the join link
function locationWithLink(escapedLocation, link) {
  const location = unescapeText(escapedLocation).trim();
  if (location.includes(link)) {
    return escapedLocation;
  }
  if (!location || GENERIC_ONLINE_LOCATION.test(location)) {
    return escapeText(link);
  }
  return escapeText(`${location} | ${link}`);
}

// Returns the sanitized iCal text of the mirror copy (without X-MIRROR-HASH).
// mirror: { uid, sourceCalendarId }; transform: the adjustments from the settings
function sanitizeIcal(icalText, mirror, transform) {
  const lines = unfoldLines(icalText);
  const utcTzids = transform.emptyTimezonesAsUtc ? findUtcTimezones(lines) : new Set();
  const out = [];
  const warnings = [];
  const stack = [];
  let meetingLink = null; // join link of the current VEVENT (setting meetingLinkInLocation)
  let hasLocation = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line == "BEGIN:VEVENT" && !stack.includes("VEVENT")) {
      const end = lines.indexOf("END:VEVENT", i);
      meetingLink = transform.meetingLinkInLocation ? findMeetingLink(lines.slice(i, end < 0 ? undefined : end + 1)) : null;
      hasLocation = false;
    }
    // Event without a location but with a join link: add a location
    if (line == "END:VEVENT" && meetingLink && !hasLocation) {
      out.push(formatLine({ name: "LOCATION", params: [], value: escapeText(meetingLink) }));
    }

    // Empty time zones are dropped (their times are written as UTC), as are Windows time zones
    // (they are replaced by IANA names whose definition the calendars know themselves)
    if (line == "BEGIN:VTIMEZONE") {
      let end = lines.indexOf("END:VTIMEZONE", i);
      if (end < 0) {
        end = lines.length - 1;
      }
      const block = lines.slice(i, end + 1);
      const tzidLine = block.find(l => l.startsWith("TZID:"));
      const tzid = tzidLine ? tzidFromLine(tzidLine) : null;
      const mapped = transform.mapWindowsTimezones && WINDOWS_TZ_TO_IANA[tzid];
      if (!tzid || (!utcTzids.has(tzid) && !mapped)) {
        out.push(...block);
      }
      i = end;
      continue;
    }

    // Drop reminders entirely if disabled
    if (line == "BEGIN:VALARM" && !transform.mirrorAlarms) {
      const end = lines.indexOf("END:VALARM", i);
      i = end < 0 ? lines.length - 1 : end;
      continue;
    }

    if (line.startsWith("BEGIN:")) {
      stack.push(line.slice(6));
      out.push(line);
      continue;
    }
    if (line.startsWith("END:")) {
      stack.pop();
      out.push(line);
      continue;
    }

    const prop = parseLine(line);
    if (!prop) {
      out.push(line);
      continue;
    }

    if (!stack.includes("VEVENT")) {
      if (!shouldDrop(prop.name, transform)) {
        out.push(line);
      }
      continue;
    }

    const component = stack[stack.length - 1];
    if (prop.name == "LOCATION" && component == "VEVENT") {
      hasLocation = true;
      if (meetingLink) {
        prop.value = locationWithLink(prop.value, meetingLink);
      }
    }

    const result = sanitizeProperty(prop, component, mirror, transform, utcTzids, warnings);
    if (result) {
      out.push(...result);
    }
  }

  return { text: out.join("\r\n") + "\r\n", warnings };
}

// Inserts X-MIRROR-HASH after the first X-MIRROR-SOURCE-UID
function addMirrorHash(icalText, hash) {
  return icalText.replace(/^(X-MIRROR-SOURCE-UID:.*\r\n)/m, `$1X-MIRROR-HASH:${hash}\r\n`);
}

function readMirrorHash(icalText) {
  return icalText.match(/^X-MIRROR-HASH:(.*?)\r?$/m)?.[1] ?? null;
}

function readMirrorSourceCalendar(icalText) {
  return icalText.match(/^X-MIRROR-SOURCE-CALENDAR:(.*?)\r?$/m)?.[1] ?? null;
}

// Splits the iCal text into its VEVENT blocks (each an array of unfolded lines, incl. BEGIN/END).
// "rest" holds all other lines, "eventsAt" the position where the VEVENTs were.
function splitEvents(icalText) {
  const rest = [];
  const events = [];
  let eventsAt = -1;
  let current = null;
  let depth = 0;
  for (const line of unfoldLines(icalText)) {
    if (!current && line == "BEGIN:VEVENT") {
      current = [line];
      depth = 0;
      if (eventsAt < 0) {
        eventsAt = rest.length;
      }
      continue;
    }
    if (!current) {
      rest.push(line);
      continue;
    }
    current.push(line);
    if (line.startsWith("BEGIN:")) {
      depth++;
    } else if (line.startsWith("END:")) {
      if (depth == 0) {
        events.push(current);
        current = null;
      } else {
        depth--;
      }
    }
  }
  return { rest, events, eventsAt: eventsAt < 0 ? rest.length : eventsAt };
}

// Properties of a VEVENT block (without subcomponents such as VALARM) as a map name -> property
function eventProperties(block) {
  const props = new Map();
  let depth = 0;
  for (const line of block.slice(1, -1)) {
    if (line.startsWith("BEGIN:")) {
      depth++;
    } else if (line.startsWith("END:")) {
      depth--;
    } else if (depth == 0) {
      const prop = parseLine(line);
      if (prop && !props.has(prop.name)) {
        props.set(prop.name, prop);
      }
    }
  }
  return props;
}

// Properties of the main event (VEVENT without RECURRENCE-ID, otherwise the first one)
function mainEventProperties(icalText) {
  const all = splitEvents(icalText).events.map(eventProperties);
  return all.find(props => !props.has("RECURRENCE-ID")) ?? all[0] ?? new Map();
}

// Maps Windows time zone names (from Exchange) to IANA: for time comparison and in the copy.
// Only applies if Owl sends a real definition; empty time zones are UTC (see findUtcTimezones).
const WINDOWS_TZ_TO_IANA = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "GMT Standard Time": "Europe/London",
  "UTC": "UTC",
};

// Offset of a time zone from UTC in ms at the instant utcMs, null if unknown
function timezoneOffsetMs(tzid, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: WINDOWS_TZ_TO_IANA[tzid] ?? tzid,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = type => Number(parts.find(p => p.type == type).value);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return local - utcMs;
  } catch {
    return null;
  }
}

// Time value as comparable text: date-time in UTC, all-day as date
function comparableTime(prop) {
  if (!prop) {
    return "";
  }
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m || !m[4]) {
    return prop.value;
  }
  const wallClock = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const tzid = paramValue(prop.params, "TZID");
  if (m[7] || !tzid) {
    return new Date(wallClock).toISOString();
  }
  const offset = timezoneOffsetMs(tzid, wallClock);
  return offset == null ? `${prop.value}@${tzid}` : new Date(wallClock - offset).toISOString();
}

// A single occurrence, for detecting duplicate events across sources.
// Expects the sanitized iCal text of an occurrence (time zones already corrected).
// key: title + actual start; recurrenceId: RECURRENCE-ID property for series, otherwise null
function occurrenceInfo(sanitizedIcal) {
  const props = mainEventProperties(sanitizedIcal);
  const summary = (props.get("SUMMARY")?.value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return {
    key: summary + "|" + comparableTime(props.get("DTSTART")),
    recurrenceId: props.get("RECURRENCE-ID") ?? null,
  };
}

// Removes the given occurrences (RECURRENCE-ID properties) from a series:
// adds EXDATEs to the main event and removes matching exception VEVENTs.
function excludeOccurrences(icalText, recurrenceIds) {
  const excluded = new Set(recurrenceIds.map(comparableTime));
  const { rest, events, eventsAt } = splitEvents(icalText);
  const exdates = recurrenceIds.map(rid =>
    formatLine({ name: "EXDATE", params: rid.params.filter(p => !p.toUpperCase().startsWith("RANGE=")), value: rid.value })
  );

  const kept = [];
  for (const block of events) {
    const rid = eventProperties(block).get("RECURRENCE-ID");
    if (rid && excluded.has(comparableTime(rid))) {
      continue;
    }
    kept.push(rid ? block : [block[0], ...exdates, ...block.slice(1)]);
  }

  const lines = [...rest.slice(0, eventsAt), ...kept.flat(), ...rest.slice(eventsAt)];
  return lines.join("\r\n") + "\r\n";
}

function readSummary(icalText) {
  return mainEventProperties(icalText).get("SUMMARY")?.value ?? "(no title)";
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
