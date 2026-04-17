#!/usr/bin/env tsx
/**
 * One-time backfill: enrich all calendar events that have an address
 * but no transport data yet.
 *
 * Usage:
 *   npx tsx scripts/backfill-transport.ts
 */

import path from 'path';
import os from 'os';

import {
  getCalendarEventsNeedingEnrichment,
  initDatabase,
} from '../src/db.js';
import { enrichCalendarEvent } from '../src/transport-enricher.js';

async function main(): Promise<void> {
  // Auto-inject gws credentials if not already set
  if (!process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) {
    const keyPath = path.join(os.homedir(), '.config', 'nanoclaw', 'gcal-sa-key.json');
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = keyPath;
  }

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error(
      'Error: GOOGLE_MAPS_API_KEY env var not set.\n' +
      'Export it before running: export GOOGLE_MAPS_API_KEY=...',
    );
    process.exit(1);
  }

  initDatabase();

  const events = getCalendarEventsNeedingEnrichment();

  if (events.length === 0) {
    console.log('No events need enrichment.');
    return;
  }

  console.log(`Enriching ${events.length} event(s)...`);

  let ok = 0;
  let fail = 0;

  // No-op sendMessage for backfill — clarification requests skipped
  const noopSend = async (_jid: string, _text: string) => {};

  for (const event of events) {
    try {
      await enrichCalendarEvent(event.id, noopSend);
      console.log(`  ✓ ${event.title} (${event.id})`);
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${event.title} (${event.id}): ${msg}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} enriched, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main();
