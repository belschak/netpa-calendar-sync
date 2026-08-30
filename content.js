// Netpa Calendar Sync - content script
// Reads the weekly schedule out of netPA, follows the "next week" links with fetch
// (same session, no tab navigation) and turns the result into an .ics file.

const SCHEDULE_BASE =
  "https://netpa.novasbe.pt/netpa/DIFTasks?_PR_=1&_AP_=11&_MD_=1&_SR_=166&_ST_=1";
const TZID = "Europe/Lisbon";
const SLOT_MINUTES = 30; // one table row is 30 minutes

// Guard so the file can also be loaded outside the extension (tests)
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action !== "build_ics") return;
    buildIcs(req.weeks)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err && err.message || err) }));
    return true; // answer asynchronously
  });
}

// ---------------------------------------------------------------- page parsing

function getScheduleBody(doc) {
  const table = doc.querySelector("table#tabhorarionew");
  if (!table) return null;
  const bodies = [...table.querySelectorAll("tbody")];
  // netPA renders the header rows as their own tbody elements; data is the last one
  return bodies[2] || bodies[1] || bodies[0] || null;
}

// Academic start year, e.g. 2026 for "2026-27"
function getAcademicStartYear(doc) {
  const sel = [...doc.querySelectorAll("select")].find((s) => {
    const opt = s.options && s.options[s.selectedIndex];
    return opt && /^\d{4}-\d{2}$/.test(opt.text.trim());
  });
  if (sel) return parseInt(sel.options[sel.selectedIndex].text.trim().slice(0, 4), 10);

  const m = (doc.querySelector(".formitemlist")?.textContent || "").match(/(\d{4})-\d{2}/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

// Column headers like "Mon 31-8" carry day and month but no year. The academic
// year runs August to July, so months before August belong to the next year.
function getDayDates(doc, acadStartYear) {
  const head = doc.querySelector(".days");
  if (!head) return [];
  return [...head.querySelectorAll("th")]
    .slice(1) // first column holds the time
    .map((th) => {
      const m = th.textContent.trim().match(/(\d{1,2})-(\d{1,2})/);
      if (!m) return null;
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      return { day, month, year: month < 8 ? acadStartYear + 1 : acadStartYear };
    });
}

function getRowStartMinutes(row) {
  const th = row.querySelector("th.time");
  if (!th) return null;
  const m = th.textContent.trim().match(/(\d{1,2})h(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// A cell reads "Course<br>Room - Shift".
// The room itself can contain dashes ("Anfiteatro D. -1.07 - TXA"), so the split
// happens at the LAST " - ", not the first one.
function parseCell(cell) {
  const div = cell.querySelector("[name=descriptionDiv]");
  if (!div) return null;

  const parts = div.innerHTML.split(/<br\s*\/?>/i);
  const course = stripTags(parts[0]);
  if (!course) return null;

  const detail = stripTags(parts[1] || "");
  const cut = detail.lastIndexOf(" - ");
  const room = cut > -1 ? detail.slice(0, cut).trim() : detail;
  const shift = cut > -1 ? detail.slice(cut + 3).trim() : "";

  return { course, room, shift };
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// The table is a grid with rowspans: a cell two rows tall is missing from the
// following row. Track how long each weekday column stays occupied and map the
// cells that are present onto the columns that are free.
function parseWeek(doc, acadStartYear) {
  const body = getScheduleBody(doc);
  if (!body) return [];

  const dayDates = getDayDates(doc, acadStartYear);
  const columns = dayDates.length;
  if (!columns) return [];

  const blockedFor = new Array(columns).fill(0);
  const events = [];

  for (const row of [...body.querySelectorAll("tr")]) {
    const startMinutes = getRowStartMinutes(row);
    const cells = [...row.querySelectorAll(".cellborder")];
    let cellIndex = 0;

    for (let col = 0; col < columns; col++) {
      if (blockedFor[col] > 0) {
        blockedFor[col]--;
        continue;
      }
      const cell = cells[cellIndex++];
      if (!cell) continue;

      const span = parseInt(cell.getAttribute("rowspan") || "1", 10) || 1;
      if (span > 1) blockedFor[col] = span - 1;

      const date = dayDates[col];
      if (startMinutes === null || !date) continue;

      const info = parseCell(cell);
      if (!info) continue;

      events.push({
        ...info,
        date,
        startMinutes,
        endMinutes: startMinutes + span * SLOT_MINUTES,
      });
    }
  }
  return events;
}

// Take the charset from the Content-Type header, fall back to the meta tag,
// then to Latin-1, which is what netPA currently serves.
function decodeHtml(buffer, contentType) {
  const fromHeader = (contentType || "").match(/charset=["']?([\w-]+)/i);
  let charset = fromHeader && fromHeader[1];

  if (!charset) {
    const head = new TextDecoder("windows-1252").decode(buffer.slice(0, 2048));
    const fromMeta = head.match(/charset=["']?([\w-]+)/i);
    charset = (fromMeta && fromMeta[1]) || "windows-1252";
  }

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (e) {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

function weekUrl(yyyymmdd) {
  return SCHEDULE_BASE + "&dtInicial=" + yyyymmdd;
}

function getNextWeekUrl(doc) {
  const link = doc.querySelector(".semanaseguinte")?.querySelector("a");
  const onclick = link?.getAttribute("onclick");
  const m = onclick && onclick.match(/'([^']+)'/);
  return m ? weekUrl(m[1]) : null;
}

// Monday of the week a document shows, as YYYYMMDD.
function getWeekStart(doc, acadStartYear) {
  const first = getDayDates(doc, acadStartYear)[0];
  return first ? pad(first.year, 4) + pad(first.month) + pad(first.day) : null;
}

async function fetchWeek(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  // netPA serves Latin-1, not UTF-8. res.text() would turn the accented letters
  // in room names into replacement characters, so decode the bytes ourselves.
  const html = decodeHtml(await res.arrayBuffer(), res.headers.get("content-type"));
  return new DOMParser().parseFromString(html, "text/html");
}

// ---------------------------------------------------------------- collecting

async function buildIcs(maxWeeks) {
  if (!getScheduleBody(document)) {
    throw new Error(
      "No schedule found on this page. Open the Weekly Schedule in Netpa and log in again if needed."
    );
  }

  const acadStartYear = getAcademicStartYear(document);
  const startWeek = getWeekStart(document, acadStartYear);
  const events = [];
  const seen = new Set();

  let doc = document;
  let weeks = 0;
  let sessionLost = false;

  while (weeks < maxWeeks) {
    for (const ev of parseWeek(doc, acadStartYear)) {
      const id = makeUid(ev);
      if (seen.has(id)) continue;
      seen.add(id);
      events.push(ev);
    }
    weeks++;

    const nextUrl = getNextWeekUrl(doc);
    if (!nextUrl) break; // end of the academic year

    try {
      doc = await fetchWeek(nextUrl);
    } catch (e) {
      sessionLost = true;
      break;
    }

    if (!getScheduleBody(doc)) {
      // netPA redirected to the login or an error page
      sessionLost = true;
      break;
    }
  }

  // netPA keeps the week you looked at last in the server side session, so reading
  // ahead moves the page you left open. Put it back where it started.
  if (startWeek && weeks > 1 && !sessionLost) {
    try {
      await fetch(weekUrl(startWeek), { credentials: "include" });
    } catch (e) {
      // cosmetic only, a failure here does not affect the export
    }
  }

  events.sort((a, b) =>
    icsStamp(a.date, a.startMinutes).localeCompare(icsStamp(b.date, b.startMinutes))
  );

  return {
    ics: toIcs(events),
    count: events.length,
    weeks,
    sessionLost,
  };
}

// ---------------------------------------------------------------- ICS

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

function icsStamp(date, minutes) {
  return (
    pad(date.year, 4) + pad(date.month) + pad(date.day) +
    "T" + pad(Math.floor(minutes / 60)) + pad(minutes % 60) + "00"
  );
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Stable across exports: the same class always produces the same UID, so a second
// import updates the existing entries instead of duplicating them.
// The room is deliberately not part of the UID. A room change has to land on the
// existing event as an update, and it cannot do that if it changes the identity.
function makeUid(ev) {
  return slug(ev.course) + "-" + icsStamp(ev.date, ev.startMinutes) + "@netpa.novasbe.pt";
}

function escapeText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545: fold lines at 75 octets
function fold(line) {
  if (line.length <= 75) return line;
  const chunks = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    chunks.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest) chunks.push(" " + rest);
  return chunks.join("\r\n");
}

function toIcs(events) {
  const now = new Date();
  const dtstamp =
    now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
    "T" + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + "Z";
  // grows with every export so calendars accept the newer version of an event
  const sequence = Math.floor(Date.now() / 60000) - 26000000;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//netpa-calendar-sync//Nova SBE//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Nova SBE",
    "X-WR-TIMEZONE:" + TZID,
    "BEGIN:VTIMEZONE",
    "TZID:" + TZID,
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0100",
    "TZNAME:WEST",
    "DTSTART:19700329T010000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0000",
    "TZNAME:WET",
    "DTSTART:19701025T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + makeUid(ev),
      "SEQUENCE:" + sequence,
      "DTSTAMP:" + dtstamp,
      "DTSTART;TZID=" + TZID + ":" + icsStamp(ev.date, ev.startMinutes),
      "DTEND;TZID=" + TZID + ":" + icsStamp(ev.date, ev.endMinutes),
      "SUMMARY:" + escapeText(ev.course),
      "LOCATION:" + escapeText(ev.room),
      "DESCRIPTION:" + escapeText(ev.shift ? "Turma " + ev.shift : ""),
      "TRANSP:OPAQUE",
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
