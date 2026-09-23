// Options page of Calendar Mirror

var { calendar: lightning } = messenger;

const TRANSFORM_KEYS = Object.keys(DEFAULT_SETTINGS.transform);

const $ = id => document.getElementById(id);

let calendars = []; // all calendars in Thunderbird
let sourceOrder = []; // selected sources in priority order
let dirty = false;

function calendarById(id) {
  return calendars.find(calendar => calendar.id == id);
}

function markDirty() {
  dirty = true;
  showMessage("Unsaved changes");
  updateDependentFields();
}

function showMessage(text, kind = "") {
  const message = $("form-message");
  message.textContent = text;
  message.className = kind;
}

// Sources: selected ones on top in priority order, the others below in alphabetical order
function renderSources() {
  const list = $("sources");
  list.replaceChildren();

  const others = calendars.filter(calendar => !sourceOrder.includes(calendar.id));
  const rows = [...sourceOrder.map(id => ({ id, selected: true })), ...others.map(c => ({ id: c.id, selected: false }))];

  rows.forEach(({ id, selected }, index) => {
    const calendar = calendarById(id);
    const li = document.createElement("li");
    li.classList.toggle("selected", selected);
    li.classList.toggle("missing", !calendar);

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = selected ? `${index + 1}.` : "";

    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected;
    checkbox.addEventListener("change", () => {
      sourceOrder = checkbox.checked ? [...sourceOrder, id] : sourceOrder.filter(other => other != id);
      renderSources();
      renderTarget();
      markDirty();
    });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = calendar ? calendar.name : `Not found (${id})`;
    const type = document.createElement("span");
    type.className = "type";
    type.textContent = calendar ? calendar.type : "";
    label.append(checkbox, name, type);

    li.append(rank, label);

    if (selected) {
      li.append(
        moveButton("↑", "Raise priority", index, -1),
        moveButton("↓", "Lower priority", index, 1)
      );
    }
    list.append(li);
  });
}

function moveButton(text, title, index, delta) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.title = title;
  const other = index + delta;
  button.disabled = other < 0 || other >= sourceOrder.length;
  button.addEventListener("click", () => {
    [sourceOrder[index], sourceOrder[other]] = [sourceOrder[other], sourceOrder[index]];
    renderSources();
    markDirty();
  });
  return button;
}

// Target: only writable calendars that are not also a source
function renderTarget() {
  const select = $("target");
  const current = select.value || select.dataset.initial || "";
  select.replaceChildren(new Option("– please choose –", ""));
  for (const calendar of calendars) {
    if (calendar.readOnly) {
      continue;
    }
    const option = new Option(`${calendar.name} (${calendar.type})`, calendar.id);
    option.disabled = sourceOrder.includes(calendar.id);
    select.append(option);
  }
  select.value = current;
  if (select.value != current || select.selectedOptions[0]?.disabled) {
    select.value = "";
  }
  updateDependentFields();
}

function updateDependentFields() {
  $("t-removeHtmlDescription").disabled = !$("t-mirrorDescription").checked;

  const target = calendarById($("target").value);
  $("reminder-warning").hidden = !(target?.showReminders && $("t-mirrorAlarms").checked);
}

function readNumber(id) {
  const input = $(id);
  const value = Number(input.value);
  if (input.value === "" || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) {
    const label = input.closest("label").querySelector("span").textContent;
    throw new Error(`${label}: whole number from ${input.min} to ${input.max}`);
  }
  return value;
}

function readForm() {
  const targetCalendarId = $("target").value;
  if (sourceOrder.length == 0) {
    throw new Error("Please choose at least one source.");
  }
  if (!targetCalendarId) {
    throw new Error("Please choose a target calendar.");
  }
  if (sourceOrder.includes(targetCalendarId)) {
    throw new Error("The target calendar must not also be a source.");
  }

  const transform = {};
  for (const key of TRANSFORM_KEYS) {
    transform[key] = $(`t-${key}`).checked;
  }

  return {
    sourceCalendarIds: [...sourceOrder],
    targetCalendarId,
    monthsBack: readNumber("months-back"),
    monthsAhead: readNumber("months-ahead"),
    resyncMinutes: readNumber("resync-minutes"),
    startupGraceMinutes: readNumber("grace-minutes"),
    dedupe: $("dedupe").checked,
    transform,
  };
}

function fillForm(settings) {
  sourceOrder = [...settings.sourceCalendarIds];
  $("target").dataset.initial = settings.targetCalendarId ?? "";
  $("months-back").value = settings.monthsBack;
  $("months-ahead").value = settings.monthsAhead;
  $("resync-minutes").value = settings.resyncMinutes;
  $("grace-minutes").value = settings.startupGraceMinutes;
  $("dedupe").checked = settings.dedupe;
  for (const key of TRANSFORM_KEYS) {
    $(`t-${key}`).checked = settings.transform[key];
  }
  renderSources();
  renderTarget();
}

function showStatus(status) {
  if (!status) {
    return;
  }
  $("status-time").textContent = new Date(status.time).toLocaleString();
  $("status-text").textContent = status.text;
  $("status-text").className = status.ok ? "ok" : "error";
}

// Renders the bundled CHANGELOG.md (only headings "## " and list items "- " are needed)
async function showChangelog() {
  const response = await fetch(messenger.runtime.getURL("CHANGELOG.md"));
  if (!response.ok) {
    return;
  }
  const container = $("changelog");
  let list = null;
  for (const line of (await response.text()).split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      const heading = document.createElement("h3");
      heading.textContent = line.slice(3);
      container.append(heading);
      list = null;
    } else if (line.startsWith("- ")) {
      if (!list) {
        list = document.createElement("ul");
        container.append(list);
      }
      const item = document.createElement("li");
      item.textContent = line.slice(2);
      list.append(item);
    }
  }
  $("changelog-box").hidden = false;
}

async function init() {
  $("version").textContent = `Version ${messenger.runtime.getManifest().version}`;
  showChangelog().catch(() => {});

  calendars = (await lightning.calendars.query({})).sort((a, b) => a.name.localeCompare(b.name));
  fillForm(await loadSettings());

  const { status } = await messenger.storage.local.get("status");
  showStatus(status);

  messenger.storage.onChanged.addListener((changes, area) => {
    if (area == "local" && changes.status) {
      showStatus(changes.status.newValue);
    }
  });

  $("settings-form").addEventListener("input", markDirty);
  $("settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await saveSettings(readForm());
      dirty = false;
      showMessage("Saved. Sync is running.", "ok");
    } catch (e) {
      showMessage(e.message, "error");
    }
  });

  $("sync-now").addEventListener("click", async () => {
    const button = $("sync-now");
    button.disabled = true;
    try {
      if (dirty) {
        showMessage("Note: the sync uses the last saved settings.");
      }
      await messenger.runtime.sendMessage({ type: "syncNow" });
    } finally {
      button.disabled = false;
    }
  });
}

init().catch(e => showMessage(`Failed to load: ${e.message}`, "error"));
