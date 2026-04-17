#!/usr/bin/env tsx
/**
 * Sync family calendar event colors from the NanoClaw DB to Google Calendar.
 *
 * Usage:
 *   npx tsx scripts/sync-calendar-colors.ts           # sync only unsynced events
 *   npx tsx scripts/sync-calendar-colors.ts --all     # re-sync all events
 *
 * Requires GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE env var pointing to a
 * service account JSON key with write access to the family calendar.
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import {
  CalendarEvent,
  getAllCalendarEvents,
  getUnsyncedCalendarEvents,
  initDatabase,
  markCalendarEventSynced,
} from '../src/db.js';

function resolveGws(): string {
  const candidates = [
    '/opt/homebrew/bin/gws',
    '/usr/local/bin/gws',
    '/usr/bin/gws',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execSync('which gws', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('gws not found. Install with: npm install -g @googleworkspace/cli');
  }
}

const GWS = resolveGws();

const FAMILY_CALENDAR_ID =
  'f028f40d56c7e321519c4fe3c256776970e044dcad91414214c9783e10c685cf@group.calendar.google.com';

const COLOR_MAP: Record<CalendarEvent['person'], string> = {
  ori: '11',    // Tomato (red)
  noam: '9',    // Blueberry (blue)
  omer: '2',    // Sage (green)
  family: '5',  // Banana (yellow)
};

function patchEventColor(eventId: string, colorId: string): void {
  execFileSync(GWS, [
    'calendar', 'events', 'patch',
    '--params', JSON.stringify({ calendarId: FAMILY_CALENDAR_ID, eventId }),
    '--json', JSON.stringify({ colorId }),
  ], { stdio: 'pipe' });
}

async function main(): Promise<void> {
  if (!process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) {
    console.error(
      'Error: GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE env var not set.\n' +
      'Point it to your service account JSON key.',
    );
    process.exit(1);
  }

  initDatabase();

  const all = process.argv.includes('--all');
  const events = all ? getAllCalendarEvents() : getUnsyncedCalendarEvents();

  if (events.length === 0) {
    console.log('No events to sync.');
    return;
  }

  console.log(`Syncing ${events.length} event(s)${all ? ' (--all)' : ''}...`);

  let ok = 0;
  let fail = 0;

  for (const event of events) {
    const colorId = COLOR_MAP[event.person];
    try {
      patchEventColor(event.id, colorId);
      markCalendarEventSynced(event.id);
      console.log(`  ✓ ${event.title} [${event.person}] → colorId ${colorId}`);
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${event.title} (${event.id}): ${msg}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} synced, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main();
