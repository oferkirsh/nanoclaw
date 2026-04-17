# Product Requirements Document: Family Calendar Person-Color Sync

**Author**: Ofer Kirshenbaum
**Date**: 2026-04-04
**Status**: Approved
**Linear**: OFE-34

---

## 1. Executive Summary

NanoClaw extracts family events from WhatsApp groups and stores them in its SQLite DB. This feature syncs those events to the Family Google Calendar and colors each event by the person it belongs to, giving an at-a-glance view of whose commitments are whose.

---

## 2. Background & Context

NanoClaw monitors several WhatsApp groups tied to family members (Ori, Noam, Omer) and creates calendar events from extracted messages. Today those events land in a shared Google Calendar but are visually undifferentiated — every event looks the same. The family calendar ID is:

```
f028f40d56c7e321519c4fe3c256776970e044dcad91414214c9783e10c685cf@group.calendar.google.com
```

There is currently no Google Calendar integration in NanoClaw's codebase. Calendar events are not tracked in the DB. This PRD specifies the end-to-end feature: DB schema, event creation with attribution, and color-sync against Google Calendar.

---

## 3. Objectives & Success Metrics

**Goals**:
1. Every event in the Family Google Calendar that originates from NanoClaw's DB has the correct person color applied.
2. New events created by NanoClaw are colored immediately at creation time.
3. Color assignment is deterministic and maintainable without code changes.

**Non-Goals**:
1. Coloring events not tracked in NanoClaw's DB (e.g. manually added via the Google Calendar UI).
2. Two-way sync — Google Calendar remains write-only from NanoClaw's perspective (NanoClaw DB is source of truth).
3. A UI for managing color assignments.
4. Supporting multiple calendars beyond the single family calendar.

**Success Metrics**:

| Metric | Target |
|--------|--------|
| All existing NanoClaw-created events colored | 100% on first backfill run |
| New events colored | At creation time (0 delay) |
| Color-sync errors surfaced to logs | 100% (no silent failures) |

---

## 4. Target Users & Segments

Single household: Ofer (admin/operator), Ori, Noam, Omer. NanoClaw is the only system that writes to this calendar on their behalf.

---

## 5. User Stories & Requirements

### P0 — Must Have

| # | User Story | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | As Ofer, I want a `calendar_events` table so NanoClaw tracks which events it created and who they belong to. | Table has: `id` (gcal event id), `title`, `start_time`, `end_time`, `person` (ori/noam/omer/family), `calendar_id`, `color_synced_at`, `created_at`. |
| 2 | As Ofer, I want events extracted from WhatsApp to be created in Google Calendar with the correct color immediately. | NanoClaw sets `colorId` at event creation time and records the row in `calendar_events`. |
| 3 | As Ofer, I want a one-time backfill script that colors all existing NanoClaw-tracked GCal events. | Script reads all `calendar_events` rows, patches each GCal event with the correct `colorId`, updates `color_synced_at`. |
| 4 | As Ofer, I want color-sync errors logged so I know when a patch fails. | Any GCal API error is logged with event id, person, and error detail. |

### P1 — Should Have

| # | User Story | Acceptance Criteria |
|---|-----------|---------------------|
| 5 | As Ofer, I want a periodic task (every 15 min) that re-syncs colors for any row where `color_synced_at IS NULL`. | NanoClaw scheduled task queries unsynced rows and patches GCal. |
| 6 | As Ofer, I want person attribution inferred automatically from the originating WhatsApp group. | Group name contains "noam" → Noam, "ori" → Ori, "omer" → Omer; otherwise → family. |

### P2 — Nice to Have / Future

| # | User Story | Acceptance Criteria |
|---|-----------|---------------------|
| 7 | A `/calendar-sync` command that manually triggers a full re-sync. | Patches all events regardless of `color_synced_at`. |
| 8 | Per-event person override via a message command. | Out of scope for v1. |

---

## 6. Solution Overview

### Color Map

| Person | Google Calendar Color | colorId |
|--------|-----------------------|---------|
| Ori    | Tomato (red)          | `11`    |
| Noam   | Blueberry (blue)      | `9`     |
| Omer   | Sage (green)          | `2`     |
| Family / shared | Banana (yellow) | `5` |

### DB Schema Addition (`src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,          -- Google Calendar event ID
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,     -- ISO 8601
  end_time TEXT,
  person TEXT NOT NULL,         -- 'ori' | 'noam' | 'omer' | 'family'
  calendar_id TEXT NOT NULL,
  color_synced_at TEXT,         -- NULL = needs sync
  created_at TEXT NOT NULL
);
```

### Google Calendar Integration

Use the [Google Workspace CLI](https://github.com/googleworkspace/cli) (`gws`) — installable as an npm package in the container (`npm install -g @googleworkspace/cli`).

**Auth: Service Account**
- Create a Google Cloud service account, share the family calendar with its email
- Store the service account JSON key in OneCLI
- Container receives the key via `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env var at runtime
- No browser flow, fully headless

**Color patch command:**
```bash
gws calendar events patch <calendarId> <eventId> --colorId=<id>
```

### Person Attribution Logic

When NanoClaw extracts an event from a WhatsApp message:
1. Check the originating `chat_jid` against `registered_groups.name`.
2. Normalize to lowercase, check for substrings: `noam`, `ori`, `omer`.
3. Fall back to `family` if no match.

### Sync Flow

```
[Scheduled task / backfill]
  → SELECT id, person FROM calendar_events WHERE color_synced_at IS NULL
  → For each row:
      PATCH /calendars/{calendarId}/events/{eventId} { colorId: <from map> }
      UPDATE calendar_events SET color_synced_at = NOW() WHERE id = ?
```

---

## 7. Open Questions

| Question | Owner | Deadline |
|----------|-------|----------|
| Should the periodic sync task live in NanoClaw's DB-driven scheduler or as a system cron? | Ofer | Design phase |

---

## 8. Timeline & Phasing

**Phase 1 (this PRD)**
1. Add `calendar_events` table migration to `src/db.ts`
2. Implement Google Calendar API client (thin wrapper, auth via OneCLI)
3. Backfill script: `scripts/sync-calendar-colors.ts`
4. Integrate event creation + color-setting into WhatsApp event-extraction flow
5. Periodic NanoClaw scheduled task for unsynced rows

**Phase 2 (future)**
- `/calendar-sync` command
- Per-event person override
