// Settings of Calendar Mirror: defaults, loading and saving.
// Used by the background script and the options page.

const DEFAULT_SETTINGS = {
  // Order = priority: if an event exists in several sources, the version of the first one wins
  sourceCalendarIds: [],
  targetCalendarId: null,
  monthsBack: 1,
  monthsAhead: 6,
  resyncMinutes: 15,
  startupGraceMinutes: 5,
  dedupe: true,
  transform: {
    removeAttendees: true,
    mirrorDescription: true,
    removeHtmlDescription: true,
    mirrorAlarms: true,
    removeVendorFields: true,
    meetingLinkInLocation: false,
    emptyTimezonesAsUtc: true,
    mapWindowsTimezones: true,
  },
};

async function loadSettings() {
  const { settings } = await messenger.storage.local.get("settings");
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    transform: { ...DEFAULT_SETTINGS.transform, ...settings?.transform },
  };
}

async function saveSettings(settings) {
  await messenger.storage.local.set({ settings });
}
