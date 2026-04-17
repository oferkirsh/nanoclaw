/**
 * One-shot script: import Noam's exam schedule from the school spreadsheet
 * into the family Google Calendar and local DB.
 *
 * Run: GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=~/.config/nanoclaw/gcal-sa-key.json \
 *      npx tsx scripts/import-noam-exams.ts
 */

import { spawnSync } from 'child_process';
import { initDatabase, upsertCalendarEvent } from '../src/db.js';

const CALENDAR_ID =
  'f028f40d56c7e321519c4fe3c256776970e044dcad91414214c9783e10c685cf@group.calendar.google.com';
const NOAM_COLOR = '9'; // Blueberry/blue

// All events derived from "לוח מבחנים שאגת הארי לאחר פסח" for class ז'5
// Format: { date, title, allDay, startTime?, endTime?, note? }
// Periods (rough Israel school clock):
//   Period 1: 08:00  Period 2: 08:50  Period 3: 09:50  Period 4: 10:40
const events = [
  // === Exams ===
  {
    date: '2026-04-20',
    title: 'מבחן בהומניסטיקה (שיעורים 3-4) - נועם',
    startTime: '09:50',
    endTime: '11:25',
  },
  {
    date: '2026-04-26',
    title: 'מבחן במדעים (שיעורים 1-2) - נועם',
    startTime: '08:00',
    endTime: '09:35',
  },
  {
    date: '2026-04-28',
    title: 'מבחן באנגלית (שיעורים 3-4) - נועם',
    startTime: '09:50',
    endTime: '11:25',
  },
  {
    date: '2026-04-30',
    title: "מבחן ערבית/צרפתית (שיעור 2) - נועם ז'5",
    startTime: '08:50',
    endTime: '09:35',
  },
  {
    date: '2026-05-06',
    title: 'מבחן במתמטיקה (שיעורים 1-2) - נועם',
    startTime: '08:00',
    endTime: '09:35',
  },
  {
    date: '2026-05-07',
    title: "מועד ב' באנגלית - נועם",
    allDay: true,
  },
  {
    date: '2026-05-10',
    title: "מועדי ב' רבי מלל - נועם",
    allDay: true,
  },
  {
    date: '2026-05-12',
    title: 'מבחן עתודה במתמטיקה - נועם',
    allDay: true,
  },
  {
    date: '2026-05-13',
    title: "מבחן מפמר שכבת ז' - נועם",
    allDay: true,
  },
  {
    date: '2026-05-14',
    title: "מועד ב' במתמטיקה - נועם",
    allDay: true,
  },
  {
    date: '2026-05-17',
    title: "מועדי ב' במקצועות המדעים והמחשב - נועם",
    allDay: true,
  },
  {
    date: '2026-05-18',
    title: 'מבחן עתודה מדעית במדע וטכנולוגיה - נועם',
    allDay: true,
  },

  // === School events / special days ===
  {
    date: '2026-06-01',
    title: 'סיפור ישראלי במוז"א - נועם',
    allDay: true,
  },
  {
    date: '2026-06-07',
    title: 'טיול שנתי - נועם (יום 1)',
    allDay: true,
  },
  {
    date: '2026-06-08',
    title: 'טיול שנתי - נועם (יום 2)',
    allDay: true,
  },
  {
    date: '2026-06-18',
    title: "חלוקת תעודות מחצית ב' - נועם",
    allDay: true,
  },

  // === Holidays / no-school days ===
  {
    date: '2026-04-14',
    title: 'יום השואה',
    allDay: true,
    color: '8', // Graphite — school day but memorial
  },
  {
    date: '2026-04-21',
    title: 'יום הזיכרון',
    allDay: true,
    color: '8',
  },
  {
    date: '2026-04-22',
    title: 'יום העצמאות - חופש',
    allDay: true,
    color: '5', // Banana
  },
  {
    date: '2026-05-05',
    title: 'ל"ג בעומר - יום חופש',
    allDay: true,
    color: '5',
  },
  {
    date: '2026-05-22',
    title: 'שבועות - חופש',
    allDay: true,
    color: '5',
  },
];

function gws(params: string, body: string): Record<string, unknown> {
  const result = spawnSync(
    'gws',
    ['calendar', 'events', 'insert', '--params', params, '--json', body],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:
          process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  // strip leading "Using keyring backend: keyring\n" if present
  const out = result.stdout;
  const json = out.slice(out.indexOf('{'));
  return JSON.parse(json);
}

async function main() {
  initDatabase();
  console.log('DB initialized.');

  let created = 0;
  let failed = 0;

  for (const ev of events) {
    const colorId = (ev as { color?: string }).color ?? NOAM_COLOR;
    let startObj: Record<string, string>;
    let endObj: Record<string, string>;

    if ((ev as { allDay?: boolean }).allDay) {
      startObj = { date: ev.date };
      endObj = { date: ev.date };
    } else {
      const startTime = (ev as { startTime?: string }).startTime!;
      const endTime = (ev as { endTime?: string }).endTime!;
      startObj = { dateTime: `${ev.date}T${startTime}:00+03:00`, timeZone: 'Asia/Jerusalem' };
      endObj = { dateTime: `${ev.date}T${endTime}:00+03:00`, timeZone: 'Asia/Jerusalem' };
    }

    const body = JSON.stringify({
      summary: ev.title,
      colorId,
      start: startObj,
      end: endObj,
    });

    try {
      const result = gws(
        JSON.stringify({ calendarId: CALENDAR_ID }),
        body,
      );

      const gcalId = result.id as string;
      const now = new Date().toISOString();

      upsertCalendarEvent({
        id: gcalId,
        title: ev.title,
        start_time: (ev as { allDay?: boolean }).allDay ? ev.date : `${ev.date}T${(ev as { startTime?: string }).startTime}:00+03:00`,
        end_time: (ev as { allDay?: boolean }).allDay ? null : `${ev.date}T${(ev as { endTime?: string }).endTime}:00+03:00`,
        person: 'noam',
        calendar_id: CALENDAR_ID,
        color_synced_at: now,
        created_at: now,
        address: null,
        walk_minutes: null,
        distance_km: null,
        origin: null,
        transport_mode: null,
        ride_alert_sent: 0,
      });

      console.log(`✓ ${ev.date}  ${ev.title}`);
      created++;
    } catch (err) {
      console.error(`✗ ${ev.date}  ${ev.title}:`, (err as Error).message);
      failed++;
    }
  }

  console.log(`\nDone: ${created} created, ${failed} failed.`);
}

main().catch(console.error);
