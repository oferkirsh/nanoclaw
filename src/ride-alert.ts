/**
 * Ride alert loop.
 *
 * Runs on the scheduler poll interval. Finds calendar events that:
 *   - have transport_mode = 'ride'
 *   - start between now+47h and now+49h
 *   - have not had a ride alert sent yet
 *
 * Sends a WhatsApp message to the family claw group and marks the alert as sent.
 */

import { FAMILY_CLAW_JID } from './config.js';
import { getPendingRideAlerts, markRideAlertSent } from './db.js';
import { logger } from './logger.js';

function formatRideAlert(event: {
  title: string;
  start_time: string;
  address: string | null;
  origin: string | null;
  walk_minutes: number | null;
  distance_km: number | null;
}): string {
  const dt = new Date(event.start_time);
  const dayName = dt.toLocaleDateString('en-IL', {
    weekday: 'long',
    timeZone: 'Asia/Jerusalem',
  });
  const dateStr = dt.toLocaleDateString('en-IL', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Jerusalem',
  });
  const timeStr = dt.toLocaleTimeString('en-IL', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jerusalem',
  });

  const lines = [
    `Ride needed 🚗`,
    `${event.title} — ${dayName}, ${dateStr} at ${timeStr}`,
  ];
  if (event.address) lines.push(`📍 ${event.address}`);
  if (event.origin) lines.push(`📍 From: ${event.origin}`);
  if (event.walk_minutes !== null && event.distance_km !== null) {
    lines.push(`🚶 ${event.walk_minutes} min walk (${event.distance_km} km)`);
  }
  return lines.join('\n');
}

export async function checkAndSendRideAlerts(
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  if (!FAMILY_CLAW_JID) {
    logger.debug('FAMILY_CLAW_JID not set, skipping ride alert check');
    return;
  }

  const pending = getPendingRideAlerts();
  if (pending.length === 0) return;

  for (const event of pending) {
    const msg = formatRideAlert(event);
    try {
      await sendMessage(FAMILY_CLAW_JID, msg);
      markRideAlertSent(event.id);
      logger.info({ eventId: event.id, title: event.title }, 'Ride alert sent');
    } catch (err) {
      logger.error({ err, eventId: event.id }, 'Failed to send ride alert');
    }
  }
}
