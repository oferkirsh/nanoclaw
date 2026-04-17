# Product Requirements Document: Map Location & Transport Alerts for Events

**Author**: Ofer Kirshenbaum
**Date**: 2026-04-05
**Status**: Approved
**Linear**: OFE-33

---

## 1. Executive Summary

NanoClaw extracts family events from WhatsApp groups and stores them in its SQLite DB. This feature enriches every event with walking-distance data, determines the right transport mode (walk / bus / ride), embeds that info in the calendar event description, and sends a proactive WhatsApp alert to the family claw group 48 hours before any event that requires a car ride.

---

## 2. Background & Context

NanoClaw monitors WhatsApp groups for family members (Ori, Noam, Omer) and creates calendar events from extracted messages. Some events include an address — a birthday party, after-school activity, or playdate. Today there is no way to tell at a glance whether a kid can walk there or needs transport, and there is no advance notice mechanism to arrange a ride.

Key nuances:
- Noam sometimes goes straight from school to an activity; other times she returns home first. The correct distance calculation depends on where she's coming from.
- Bus is the default non-walking option, but is not always available (war, late evening, Shabbat).

**Reference points**:
- Home: Kehilat Varsha St 15
- Noam's school: Mordechai Namir Rd 81, Tel Aviv-Yafo, 6233709
- School hours: fetched dynamically from SmartSchool

---

## 3. Objectives & Success Metrics

**Goals**:
1. Every NanoClaw calendar event with an address shows walking time and recommended transport mode in its description.
2. The correct origin (home or school) is used based on event timing and proximity.
3. Bus is recommended when available; ride (car) is flagged with a 48h WhatsApp alert.
4. Transport data is persisted in the DB so it survives restarts and doesn't re-query APIs.

**Non-Goals**:
1. Booking rides or looking up bus routes/numbers — alerts are informational only.
2. Calculating distance from school as a standalone feature (school is only used as origin when applicable).
3. Retroactively alerting for past events or events already within the 48h window at enrichment time.

**Success Metrics**:

| Metric | Target |
|--------|--------|
| Events with address that have transport data | 100% within 5 min of creation |
| Correct origin selected (home vs. school) | 100% |
| False negatives (missed ride alerts) | 0 |
| Duplicate alerts for the same event | 0 |
| Map API errors surfaced to logs | 100% (no silent failures) |

---

## 4. Target Users & Segments

**Primary**: Ofer — receives ride alerts and acts on them.
**Secondary**: Any family member whose event is extracted (Noam is the primary subject; Ori and Omer follow same logic).

---

## 5. User Stories & Requirements

**P0 — Must Have**:

| # | User Story | Acceptance Criteria |
|---|-----------|-------------------|
| 1 | As Ofer, I want the correct origin used for distance calculation | If event starts within 90 min of school end AND destination is closer to school than home → origin = school. Otherwise → origin = home |
| 2 | As Ofer, I want walking distance and transport mode stored per event | `walk_minutes`, `distance_km`, `origin`, `transport_mode` stored in DB within 5 min of event creation |
| 3 | As Ofer, I want the calendar event description to include transport info | Description shows origin, walking time, km, and recommended mode |
| 4 | As Ofer, I want a WhatsApp alert 48h before any event that needs a car ride | Alert sent exactly 48h (±5 min) before event; includes event name, date/time, address, origin, and distance |
| 5 | As Ofer, I want ride alerts sent only once per event | No duplicate WhatsApp alerts for the same event even after restarts |

**P1 — Should Have**:

| # | User Story | Acceptance Criteria |
|---|-----------|-------------------|
| 6 | As Ofer, if distance calculation fails, I want to know | Log entry + WhatsApp message when geocoding or Distance Matrix call fails |
| 7 | As Ofer, if an event is updated with a new address, I want transport recalculated | Re-enrichment triggered on address change; DB and calendar event updated |

**P2 — Nice to Have / Future**:

| # | User Story | Acceptance Criteria |
|---|-----------|-------------------|
| 8 | As Ofer, get a morning-of reminder for same-day ride events | Additional WhatsApp alert at 08:00 on event day if ride needed |

---

## 6. Solution Overview

### Origin Selection Logic

Fetch Noam's school end time from SmartSchool for the event date. Then:

```
if (event_start_time - school_end_time) <= 90 min
   AND distance(school → destination) < distance(home → destination):
     origin = school
else:
     origin = home
```

### Transport Mode Decision Tree

```
1. Calculate walk_minutes from origin → destination (Google Maps, walking mode)

2. If walk_minutes <= 15:
     transport_mode = 'walk'

3. Else:
     Check bus availability:
       - WAR_MODE active?         → no bus
       - event_time after 21:00?  → no bus
       - event on Saturday?       → no bus (no buses in Israel on Shabbat)

     If bus available:
       transport_mode = 'bus'
     Else:
       transport_mode = 'ride'
```

**WAR_MODE** is a config flag in `src/config.ts` (currently `true` — Israel/USA vs. Iran). Toggle to `false` when no longer active.

### Flow

1. **Event creation** — when NanoClaw writes a new event to the DB, check for an address. If none, attempt geocoding the venue name via Google Maps Geocoding API. If ambiguous, send a clarification request to the family claw group and proceed without transport data until resolved.
2. **Origin selection** — fetch school schedule from SmartSchool; apply origin logic above.
3. **Enrichment** — call Google Maps Distance Matrix API (walking mode) for the selected origin → destination pair. Apply transport decision tree. Store all results in DB.
4. **Calendar write** — append transport line to the Google Calendar event description (OFE-34 integration):
   - Walk: `🚶 Walk: ~12 min (0.9 km from home)`
   - Bus: `🚌 Bus recommended: ~38 min walk (3.1 km from school)`
   - Ride: `🚗 Ride needed: ~38 min walk (3.1 km from home)`
5. **Scheduler** — `task-scheduler.ts` checks for events 48h away with `transport_mode = 'ride'` and `ride_alert_sent = false`. Sends WhatsApp alert to family claw group, sets `ride_alert_sent = true`.
6. **Backfill** — one-time migration on first deploy enriches all existing events that have an address but no transport data.

### DB changes

```sql
walk_minutes       INTEGER,        -- null if no address or geocoding failed
distance_km        REAL,
origin             TEXT,           -- 'home' or 'school'
transport_mode     TEXT,           -- 'walk', 'bus', or 'ride'
ride_alert_sent    BOOLEAN DEFAULT 0
```

### Config (`src/config.ts`)

```ts
WAR_MODE: true,   // no bus when true; toggle false when war ends
```

### WhatsApp alert format (ride only)

```
Ride needed 🚗
[Event name] — [Day, Date] at [Time]
📍 [Address]
📍 From: [home / school]
🚶 [X] min walk ([Y] km)
```

### Geocoding clarification format

```
❓ Need help with an event location
[Event name] — [Day, Date]
Venue: "[venue name as extracted]"
Can you share the exact address?
```

### APIs & Auth

- Google Maps Distance Matrix API (walking mode)
- Google Maps Geocoding API (venue name fallback)
- SmartSchool (school schedule, read-only)

All credentials via OneCLI credential vault (`GOOGLE_MAPS_API_KEY`, SmartSchool session).

---

## 7. Open Questions

All pre-implementation questions resolved. No open questions.

---

## 8. Timeline & Phasing

**Phase 1 (this PRD)**
- Config flag: `WAR_MODE`
- SmartSchool school-hours fetch
- Origin selection logic (home vs. school)
- Transport mode decision tree (walk / bus / ride)
- Google Maps enrichment on event creation (address + venue name geocoding)
- Backfill migration for existing events
- Calendar description update (depends on OFE-34)
- 48h ride alert to family claw group
- Geocoding clarification requests to family claw group

**Phase 2 (future)**
- Morning-of reminder for ride events
- Real-time bus route lookup
