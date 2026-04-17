/**
 * Transport enrichment for calendar events.
 *
 * For each event with a physical address, determines:
 * 1. Origin (home or school) based on event timing
 * 2. Walking distance and time via Google Maps Distance Matrix API
 * 3. Transport mode: walk / bus / ride
 *
 * Calls Google Maps Geocoding API for venue names that aren't full addresses.
 * Sends a WhatsApp clarification request when geocoding is ambiguous.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  FAMILY_CLAW_JID,
  GOOGLE_MAPS_API_KEY,
  HOME_ADDRESS,
  NOAM_SCHOOL_ADDRESS,
  SCHOOL_TO_ACTIVITY_WINDOW_MINUTES,
  WALK_THRESHOLD_MINUTES,
  WAR_MODE,
} from './config.js';
import {
  getCalendarEventById,
  getSchoolSchedule,
  updateCalendarEventTransport,
} from './db.js';
import { logger } from './logger.js';

const FAMILY_CALENDAR_ID =
  'f028f40d56c7e321519c4fe3c256776970e044dcad91414214c9783e10c685cf@group.calendar.google.com';
const DEFAULT_SCHOOL_END_TIME = '15:00';

// Resolve gws at module load time
let gwsBin: string | null = null;
for (const p of [
  '/opt/homebrew/bin/gws',
  '/usr/local/bin/gws',
  '/usr/bin/gws',
]) {
  if (fs.existsSync(p)) {
    gwsBin = p;
    break;
  }
}

interface LatLng {
  lat: number;
  lng: number;
}

async function geocodeAddress(address: string): Promise<LatLng | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    logger.warn('GOOGLE_MAPS_API_KEY not set, skipping geocoding');
    return null;
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as {
    status: string;
    results: Array<{ geometry: { location: LatLng } }>;
  };
  if (data.status !== 'OK' || !data.results.length) return null;
  return data.results[0].geometry.location;
}

async function getWalkingDistanceMinutes(
  originAddress: string,
  destinationAddress: string,
): Promise<{ minutes: number; km: number } | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    logger.warn('GOOGLE_MAPS_API_KEY not set, skipping distance matrix');
    return null;
  }
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(originAddress)}` +
    `&destinations=${encodeURIComponent(destinationAddress)}` +
    `&mode=walking` +
    `&key=${GOOGLE_MAPS_API_KEY}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as {
    status: string;
    rows: Array<{
      elements: Array<{
        status: string;
        duration: { value: number };
        distance: { value: number };
      }>;
    }>;
  };
  if (data.status !== 'OK') return null;
  const element = data.rows[0]?.elements[0];
  if (!element || element.status !== 'OK') return null;
  return {
    minutes: Math.round(element.duration.value / 60),
    km: Math.round((element.distance.value / 1000) * 10) / 10,
  };
}

function getSchoolEndTime(date: string): string {
  return getSchoolSchedule(date) ?? DEFAULT_SCHOOL_END_TIME;
}

function determineOrigin(
  eventStartIso: string,
  eventDate: string,
  walkFromHome: number,
  walkFromSchool: number,
): 'home' | 'school' {
  const endTimeStr = getSchoolEndTime(eventDate);
  const [endHour, endMin] = endTimeStr.split(':').map(Number);

  const eventStart = new Date(eventStartIso);
  const schoolEnd = new Date(eventStartIso);
  schoolEnd.setHours(endHour, endMin, 0, 0);

  const minutesSinceSchoolEnd =
    (eventStart.getTime() - schoolEnd.getTime()) / 60000;

  if (
    minutesSinceSchoolEnd >= 0 &&
    minutesSinceSchoolEnd <= SCHOOL_TO_ACTIVITY_WINDOW_MINUTES &&
    walkFromSchool < walkFromHome
  ) {
    return 'school';
  }
  return 'home';
}

function determineTransportMode(
  walkMinutes: number,
  eventStartIso: string,
): 'walk' | 'bus' | 'ride' {
  if (walkMinutes <= WALK_THRESHOLD_MINUTES) return 'walk';

  const eventTime = new Date(eventStartIso);
  const hour = eventTime.getHours();
  const isSaturday = eventTime.getDay() === 6;

  const busUnavailable = WAR_MODE || hour >= 21 || isSaturday;
  return busUnavailable ? 'ride' : 'bus';
}

function patchCalendarEventDescription(
  eventId: string,
  description: string,
): void {
  if (!gwsBin) {
    logger.warn('gws not found, skipping calendar description update');
    return;
  }
  // Inject gws credentials if not already in environment
  const env = { ...process.env };
  if (!env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) {
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = path.join(
      os.homedir(),
      '.config',
      'nanoclaw',
      'gcal-sa-key.json',
    );
  }
  try {
    execFileSync(
      gwsBin,
      [
        'calendar',
        'events',
        'patch',
        '--params',
        JSON.stringify({ calendarId: FAMILY_CALENDAR_ID, eventId }),
        '--json',
        JSON.stringify({ description }),
      ],
      { stdio: 'pipe', env },
    );
  } catch (err) {
    logger.warn({ eventId, err }, 'Failed to patch calendar event description');
  }
}

function buildTransportDescription(
  transportMode: 'walk' | 'bus' | 'ride',
  walkMinutes: number,
  km: number,
  origin: 'home' | 'school',
): string {
  const dist = `~${walkMinutes} min walk (${km} km from ${origin})`;
  if (transportMode === 'walk') return `🚶 Walk: ${dist}`;
  if (transportMode === 'bus') return `🚌 Bus recommended: ${dist}`;
  return `🚗 Ride needed: ${dist}`;
}

/**
 * Enrich a calendar event with transport data.
 * `sendMessage` is used to send geocoding clarification requests.
 */
export async function enrichCalendarEvent(
  eventId: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const event = getCalendarEventById(eventId);
  if (!event) {
    logger.warn({ eventId }, 'enrichCalendarEvent: event not found');
    return;
  }
  if (!event.address) {
    logger.debug({ eventId }, 'enrichCalendarEvent: no address, skipping');
    return;
  }

  const eventDate = event.start_time.slice(0, 10); // YYYY-MM-DD

  // Get walking distances from both origins in parallel
  const [fromHome, fromSchool] = await Promise.all([
    getWalkingDistanceMinutes(HOME_ADDRESS, event.address),
    getWalkingDistanceMinutes(NOAM_SCHOOL_ADDRESS, event.address),
  ]);

  if (!fromHome) {
    logger.warn({ eventId, address: event.address }, 'Distance Matrix failed');
    return;
  }

  const origin = fromSchool
    ? determineOrigin(
        event.start_time,
        eventDate,
        fromHome.minutes,
        fromSchool.minutes,
      )
    : 'home';

  const { minutes, km } =
    origin === 'school' && fromSchool ? fromSchool : fromHome;
  const transportMode = determineTransportMode(minutes, event.start_time);

  updateCalendarEventTransport(eventId, {
    walk_minutes: minutes,
    distance_km: km,
    origin,
    transport_mode: transportMode,
  });

  logger.info(
    { eventId, origin, minutes, km, transportMode },
    'Transport enrichment complete',
  );

  // Update Google Calendar event description
  const transportLine = buildTransportDescription(
    transportMode,
    minutes,
    km,
    origin,
  );
  patchCalendarEventDescription(eventId, transportLine);
}

/**
 * Attempt to geocode a venue name. Returns the resolved address string or null.
 * If the venue is ambiguous (multiple candidates), sends a WhatsApp clarification
 * request and returns null.
 */
export async function resolveVenueAddress(
  venueName: string,
  eventTitle: string,
  eventDate: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<string | null> {
  if (!GOOGLE_MAPS_API_KEY) return null;

  // Try geocoding with Tel Aviv context to improve accuracy
  const query = `${venueName}, Tel Aviv`;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as {
    status: string;
    results: Array<{
      formatted_address: string;
      geometry: { location: LatLng };
      partial_match?: boolean;
    }>;
  };

  if (data.status !== 'OK' || !data.results.length) {
    await sendClarificationRequest(
      venueName,
      eventTitle,
      eventDate,
      sendMessage,
    );
    return null;
  }

  // If there's a clear single result without partial_match, trust it
  const top = data.results[0];
  if (!top.partial_match && data.results.length === 1) {
    return top.formatted_address;
  }

  // Multiple or partial results — ask for clarification
  await sendClarificationRequest(venueName, eventTitle, eventDate, sendMessage);
  return null;
}

async function sendClarificationRequest(
  venueName: string,
  eventTitle: string,
  eventDate: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  if (!FAMILY_CLAW_JID) {
    logger.warn('FAMILY_CLAW_JID not set, cannot send geocoding clarification');
    return;
  }
  const msg =
    `❓ Need help with an event location\n` +
    `${eventTitle} — ${eventDate}\n` +
    `Venue: "${venueName}"\n` +
    `Can you share the exact address?`;
  try {
    await sendMessage(FAMILY_CLAW_JID, msg);
  } catch (err) {
    logger.error({ err }, 'Failed to send geocoding clarification');
  }
}
