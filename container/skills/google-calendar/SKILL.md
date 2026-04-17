---
name: google-calendar
description: Create and update Google Calendar events using the gws CLI. Handles event creation with person-color attribution for the family calendar.
---

# Google Calendar Integration

Use the `gws` CLI (`@googleworkspace/cli`) to interact with Google Calendar.

## Authentication

Credentials are injected at runtime via the `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` environment variable (service account JSON). No manual auth step needed.

## Family Calendar

Calendar ID: `f028f40d56c7e321519c4fe3c256776970e044dcad91414214c9783e10c685cf@group.calendar.google.com`

## Color Map

| Person | colorId |
|--------|---------|
| ori    | 11 (Tomato/red) |
| noam   | 9 (Blueberry/blue) |
| omer   | 2 (Sage/green) |
| family | 5 (Banana/yellow) |

## Creating an Event

```bash
gws calendar events insert \
  --params '{"calendarId":"<calendarId>"}' \
  --json '{"summary":"Event title","colorId":"9","start":{"dateTime":"2026-04-05T18:00:00+03:00"},"end":{"dateTime":"2026-04-05T19:00:00+03:00"}}'
```

The command outputs JSON including the created event `id`. Always capture this ID and report it so NanoClaw can store it in the `calendar_events` table.

## Updating an Event's Color

```bash
gws calendar events patch \
  --params '{"calendarId":"<calendarId>","eventId":"<eventId>"}' \
  --json '{"colorId":"9"}'
```

## Person Attribution

Infer `person` from the originating WhatsApp group name (lowercase):
- Contains `noam` → `noam` (colorId 9)
- Contains `ori` → `ori` (colorId 11)
- Contains `omer` → `omer` (colorId 2)
- No match → `family` (colorId 5)

## After Creating an Event

Report the following back via IPC (write to the group's `tasks/` IPC directory) so NanoClaw stores it in the DB and enriches it with transport data:
```json
{
  "type": "calendar_event_created",
  "id": "<gcal_event_id>",
  "title": "<event title>",
  "start_time": "<ISO 8601>",
  "end_time": "<ISO 8601 or null>",
  "person": "<ori|noam|omer|family>",
  "calendar_id": "<calendarId>",
  "address": "<full street address or venue name, if known — omit if not available>"
}
```

Include `address` whenever the event has a physical location. This triggers automatic transport enrichment (walking distance, transport mode recommendation, and 48h ride alert if needed).
