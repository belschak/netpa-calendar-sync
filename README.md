# Netpa Calendar Sync

A Chrome extension that exports your Nova SBE schedule from Netpa as an `.ics` file, so your
classes end up in Google Calendar, Apple Calendar or Outlook with the right rooms and the right
timezone.

Netpa has no calendar feed. The schedule only exists as an HTML table you page through one week
at a time. This reads that table for as many weeks as you ask for and hands you a file.

## Install

There is no Web Store listing, you load the folder yourself.

1. Download this repo (green Code button, then Download ZIP) and unzip it somewhere you will not
   delete by accident. Chrome loads the extension from that folder every time it starts.
2. Open `chrome://extensions/`
3. Turn on Developer mode, top right
4. Click Load unpacked and pick the unzipped folder

Chrome, Edge, Brave, Arc, anything Chromium based.

## Use

1. Log into Netpa and open Weekly Schedule
2. Page to the first week you want, normally the first week of the semester
3. Click the extension icon, set how many weeks to read, click Export calendar
4. Import the file it downloads

Google Calendar: Settings, then Import & export. Create a separate calendar first (call it
Nova SBE or whatever) and import into that one. You can then hide your whole timetable with one
checkbox, and delete it in one click when the semester ends, without touching your own events.

Apple Calendar: double click the file, or File > Import.

Outlook: File > Open & Export > Import/Export > Import an iCalendar (.ics) file.

Rooms change during the semester. Export again and import the new file: every class carries a UID
built from the course name and the start time, so the import updates the event you already have
instead of adding a second one. The room is deliberately left out of that UID, otherwise a room
change would look like a different class.

## How it works

The extension has no server, no account, no background process. It reads the pages Netpa serves
to your own browser during your own session, in the tab you already have open. Nothing leaves
your machine except the file you download.

`manifest.json` asks for zero Chrome permissions and access to exactly one host,
`netpa.novasbe.pt`. The whole program is `content.js`, about 300 lines, and you should read it
before loading unpacked code from a stranger on the internet.

Two things in that file are less obvious than they look. The schedule table is a grid with
rowspans, so a class that runs 90 minutes swallows the next two rows and every cell after it in
those rows shifts left; the parser tracks how long each weekday column stays occupied instead of
counting cells. And Netpa serves Latin-1, not UTF-8, so the bytes are decoded explicitly.
Otherwise `Auditório B.0.08` comes back as `Audit?rio B.0.08`.

Netpa keeps the week you last looked at in the server side session. Reading ahead therefore moves
the page you left open, and the extension puts it back on the week you started from when it is
done.

`test/parser-test.html` runs the parser against a copy of the Netpa markup, including the rowspan
overlaps. Open it in a browser, no build step, no dependencies.

## Differences from the Nova Tech Club exporter

The idea comes from [novatechclub/netpa-calendar-exporter](https://github.com/novatechclub/netpa-calendar-exporter)
(MIT, 2023). I started from there and rewrote it. Four things made me do that.

**Rooms in the D building.** Netpa writes a cell as `Anfiteatro D .-1.10 - TXD`. The original
splits that string at the first dash, which leaves `D` as the room and `1.10` as the class group.
35 of my 59 classes this semester are in that building. Splitting at the last ` - ` instead keeps
the room as `Anfiteatro D .-1.10` and the group as `TXD`.

**Event IDs.** The original numbers its events, so the first class of the file is `0@default`,
the second is `1@default`, and so on. Import a corrected file later and the numbering has shifted,
so the update lands on the wrong events. Here the ID comes from the course and the start time.

**Timezone.** The original writes plain local timestamps with no `VTIMEZONE` block. Every event
here is anchored to `TZID=Europe/Lisbon`, so the times stay right when you import from a laptop
that is still set to your home timezone.

**Reading ahead.** The original walks the weeks by clicking through the page, and its loop has a
condition that can never end; a one line fix for it has been sitting in an
[open pull request](https://github.com/novatechclub/netpa-calendar-exporter/pull/2) since July
2025. This version fetches the weeks in the background instead of navigating the tab.

It also opens an Instagram tab when the export finishes. This one does nothing after handing you
the file.

## Known limits

- No automatic sync. Changes in Netpa reach your calendar when you export again, not before.
- Netpa drops your session after roughly an hour. If it expires mid export you still get the
  weeks that were read, and the popup tells you how far it came.
- I have tested this on one schedule, mine, in the 2026-27 fall semester: 59 classes across
  14 weeks, checked event by event against the calendar after import. Other programmes may put
  things in the table that I have never seen.
- Chromium browsers only. There is no Firefox or Safari build.

## License

MIT. The original Nova Tech Club exporter is MIT as well and is credited in the LICENSE file.
