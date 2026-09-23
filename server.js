#!/usr/bin/env node
/**
 * Google Calendar MCP server for a single Google account, served over stdio.
 *
 * Scopes are calendar.readonly plus calendar.events: read everything, write
 * events, answer invitations. It cannot create or delete calendars or change
 * sharing.
 *
 * Read tools are safe to call freely. The four write tools (create_event,
 * update_event, delete_event, respond_to_event) change a shared calendar and
 * may email other people, so pin them to an "ask" permission rule in your MCP
 * client (see README.md).
 */
import { readFileSync, existsSync } from 'node:fs';
import { google } from 'googleapis';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CREDENTIALS, TOKEN } from './config.js';
import { EVENT_COLORS, resolveColorId } from './colors.js';

function calendarClient() {
  if (!existsSync(CREDENTIALS)) throw new Error(`Missing ${CREDENTIALS}. See README.md.`);
  if (!existsSync(TOKEN)) throw new Error(`Missing ${TOKEN}. Run: npm run auth`);

  const raw = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
  const cfg = raw.installed ?? raw.web ?? raw;
  const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
  oauth2.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf8')));
  return google.calendar({ version: 'v3', auth: oauth2 });
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const DAY_MS = 24 * 60 * 60 * 1000;
const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Trim a Google event resource down to the fields a client actually needs. */
function formatEvent(e, calendarId) {
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id,
    calendarId,
    summary: e.summary ?? '(no title)',
    status: e.status,
    allDay,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    timeZone: e.start?.timeZone,
    location: e.location,
    colorId: e.colorId,
    color: e.colorId ? EVENT_COLORS[e.colorId] : undefined,
    description: e.description && e.description.length > 1000
      ? `${e.description.slice(0, 1000)}...`
      : e.description,
    organizer: e.organizer?.email,
    creator: e.creator?.email,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
      optional: a.optional || undefined,
      organizer: a.organizer || undefined,
      self: a.self || undefined,
    })),
    recurringEventId: e.recurringEventId,
    recurrence: e.recurrence,
    hangoutLink: e.hangoutLink,
    htmlLink: e.htmlLink,
    updated: e.updated,
  };
}

/**
 * Build the {date} or {dateTime, timeZone} shape Google expects.
 * A bare YYYY-MM-DD means all-day. Anything else is an RFC 3339 timestamp;
 * when it carries no offset, timeZone says how to interpret it.
 */
function toEventTime(value, timeZone) {
  if (!value) return undefined;
  if (isDateOnly(value)) return { date: value };
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!hasOffset && !timeZone) {
    throw new Error(`"${value}" has no UTC offset; pass timeZone (IANA name) or include an offset.`);
  }
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

/** Google requires all-day ends to be exclusive; make a single-day event when only start is given. */
function allDayEnd(start, end) {
  if (end) return { date: end };
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { date: next.toISOString().slice(0, 10) };
}

async function calendarTimeZone(calendar, calendarId) {
  const { data } = await calendar.calendars.get({ calendarId });
  return data.timeZone;
}

const TOOLS = [
  {
    name: 'list_calendars',
    description: 'List the calendars visible to the account with their ids, access roles and time zones. Use the ids with the other tools; "primary" always means the main calendar.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_events',
    description:
      'List events in a time window, expanded so recurring events appear as individual occurrences, ordered by start time. ' +
      'Defaults to the primary calendar and the next 7 days. Use search_events for keyword lookups.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id from list_calendars. Default "primary".' },
        timeMin: { type: 'string', description: 'RFC 3339 lower bound (inclusive). Default now.' },
        timeMax: { type: 'string', description: 'RFC 3339 upper bound (exclusive). Default timeMin + 7 days.' },
        maxResults: { type: 'number', description: 'Max events (default 50, max 250).' },
      },
    },
  },
  {
    name: 'search_events',
    description:
      'Free-text search over event titles, descriptions, locations and attendees. ' +
      'Defaults to the primary calendar and a window from 1 year ago to 1 year ahead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text.' },
        calendarId: { type: 'string', description: 'Default "primary".' },
        timeMin: { type: 'string', description: 'RFC 3339 lower bound. Default 1 year ago.' },
        timeMax: { type: 'string', description: 'RFC 3339 upper bound. Default 1 year ahead.' },
        maxResults: { type: 'number', description: 'Max events (default 50, max 250).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_event',
    description: 'Fetch one event in full by id.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        calendarId: { type: 'string', description: 'Default "primary".' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'find_free_time',
    description:
      'Return busy blocks and the free gaps between them for one or more calendars inside a time window. ' +
      'Useful for "when am I free" and for picking a meeting slot.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'RFC 3339 start of the window.' },
        timeMax: { type: 'string', description: 'RFC 3339 end of the window.' },
        calendarIds: { type: 'array', items: { type: 'string' }, description: 'Calendars to combine. Default ["primary"].' },
        minDurationMinutes: { type: 'number', description: 'Only report free gaps at least this long (default 30).' },
      },
      required: ['timeMin', 'timeMax'],
    },
  },
  {
    name: 'create_event',
    description:
      'Create an event. WRITES to the calendar. Pass a bare YYYY-MM-DD start for an all-day event, otherwise an RFC 3339 start and end. ' +
      'Attendees are only emailed when sendUpdates is "all" or "externalOnly"; the default "none" invites silently.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Title.' },
        start: { type: 'string', description: 'YYYY-MM-DD for all-day, or RFC 3339 timestamp.' },
        end: { type: 'string', description: 'Same format as start. For all-day, exclusive; omit for a single day.' },
        timeZone: { type: 'string', description: 'IANA zone for timestamps without an offset. Default: the calendar\'s zone.' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses.' },
        recurrence: { type: 'array', items: { type: 'string' }, description: 'RRULE lines, e.g. ["RRULE:FREQ=WEEKLY;COUNT=4"].' },
        reminderMinutes: { type: 'array', items: { type: 'number' }, description: 'Popup reminders in minutes before start. Omit for calendar defaults.' },
        colorId: { type: 'string', description: 'Event colour, by name or number: 1 Lavender, 2 Sage, 3 Grape, 4 Flamingo, 5 Banana, 6 Tangerine, 7 Peacock, 8 Graphite, 9 Blueberry, 10 Basil, 11 Tomato. Omit for the calendar default.' },
        calendarId: { type: 'string', description: 'Default "primary".' },
        sendUpdates: { type: 'string', enum: ['none', 'all', 'externalOnly'], description: 'Whether to email attendees. Default "none".' },
      },
      required: ['summary', 'start'],
    },
  },
  {
    name: 'update_event',
    description:
      'Change fields on an existing event. WRITES to the calendar. Only the fields you pass are changed. ' +
      'For a recurring series pass the series id to change every occurrence, or the occurrence id from list_events to change one.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        calendarId: { type: 'string', description: 'Default "primary".' },
        summary: { type: 'string' },
        start: { type: 'string', description: 'YYYY-MM-DD or RFC 3339. Pass start and end together.' },
        end: { type: 'string' },
        timeZone: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Replaces the attendee list.' },
        colorId: { type: 'string', description: 'Event colour, by name or number: 1 Lavender, 2 Sage, 3 Grape, 4 Flamingo, 5 Banana, 6 Tangerine, 7 Peacock, 8 Graphite, 9 Blueberry, 10 Basil, 11 Tomato. Omit for the calendar default.' },
        sendUpdates: { type: 'string', enum: ['none', 'all', 'externalOnly'], description: 'Default "none".' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete an event. WRITES to the calendar and cannot be undone. Attendees are emailed only when sendUpdates is "all" or "externalOnly".',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        calendarId: { type: 'string', description: 'Default "primary".' },
        sendUpdates: { type: 'string', enum: ['none', 'all', 'externalOnly'], description: 'Default "none".' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'respond_to_event',
    description:
      'Accept, decline or tentatively accept an invitation on behalf of the account. WRITES the RSVP and, by default, notifies the organizer.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        response: { type: 'string', enum: ['accepted', 'declined', 'tentative'] },
        comment: { type: 'string', description: 'Optional note for the organizer.' },
        calendarId: { type: 'string', description: 'Default "primary".' },
        sendUpdates: { type: 'string', enum: ['none', 'all', 'externalOnly'], description: 'Default "all".' },
      },
      required: ['eventId', 'response'],
    },
  },
];

async function listCalendars() {
  const calendar = calendarClient();
  const { data } = await calendar.calendarList.list({ maxResults: 250 });
  return {
    calendars: (data.items ?? []).map((c) => ({
      id: c.id,
      summary: c.summaryOverride ?? c.summary,
      primary: c.primary || undefined,
      accessRole: c.accessRole,
      timeZone: c.timeZone,
      hidden: c.hidden || undefined,
    })),
  };
}

async function queryEvents({ calendarId = 'primary', timeMin, timeMax, maxResults, query }, defaults) {
  const calendar = calendarClient();
  const min = timeMin ? new Date(timeMin) : defaults.min();
  const max = timeMax ? new Date(timeMax) : defaults.max(min);
  if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime())) {
    throw new Error('timeMin/timeMax must be RFC 3339 timestamps, e.g. 2026-09-13T09:00:00-04:00.');
  }
  const { data } = await calendar.events.list({
    calendarId,
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
    q: query || undefined,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: Math.min(Math.max(Number(maxResults) || 50, 1), 250),
  });
  const events = (data.items ?? []).map((e) => formatEvent(e, calendarId));
  return {
    calendarId,
    timeZone: data.timeZone,
    window: { timeMin: min.toISOString(), timeMax: max.toISOString() },
    count: events.length,
    events,
  };
}

const listEvents = (args) =>
  queryEvents(args, { min: () => new Date(), max: (min) => new Date(min.getTime() + 7 * DAY_MS) });

const searchEvents = (args) => {
  if (!args.query) throw new Error('query is required.');
  return queryEvents(args, {
    min: () => new Date(Date.now() - 365 * DAY_MS),
    max: () => new Date(Date.now() + 365 * DAY_MS),
  });
};

async function getEvent({ eventId, calendarId = 'primary' }) {
  const calendar = calendarClient();
  const { data } = await calendar.events.get({ calendarId, eventId });
  return formatEvent(data, calendarId);
}

async function findFreeTime({ timeMin, timeMax, calendarIds, minDurationMinutes }) {
  const calendar = calendarClient();
  const ids = asArray(calendarIds).filter(Boolean);
  if (ids.length === 0) ids.push('primary');
  const min = new Date(timeMin);
  const max = new Date(timeMax);
  if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime()) || max <= min) {
    throw new Error('timeMin must be before timeMax and both must be RFC 3339 timestamps.');
  }
  const { data } = await calendar.freebusy.query({
    requestBody: { timeMin: min.toISOString(), timeMax: max.toISOString(), items: ids.map((id) => ({ id })) },
  });

  // Merge every calendar's busy blocks into one sorted, non-overlapping list.
  const busy = Object.values(data.calendars ?? {})
    .flatMap((c) => c.busy ?? [])
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
    .sort((a, b) => a.start - b.start)
    .reduce((acc, b) => {
      const last = acc[acc.length - 1];
      if (last && b.start <= last.end) last.end = new Date(Math.max(last.end, b.end));
      else acc.push({ ...b });
      return acc;
    }, []);

  const minMs = Math.max(Number(minDurationMinutes) || 30, 1) * 60 * 1000;
  const free = [];
  let cursor = min;
  for (const b of busy) {
    if (b.start - cursor >= minMs) free.push({ start: cursor, end: b.start });
    if (b.end > cursor) cursor = b.end;
  }
  if (max - cursor >= minMs) free.push({ start: cursor, end: max });

  const iso = (r) => ({
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    minutes: Math.round((r.end - r.start) / 60000),
  });
  const errors = Object.entries(data.calendars ?? {})
    .filter(([, c]) => c.errors?.length)
    .map(([id, c]) => ({ calendarId: id, errors: c.errors }));
  return {
    calendarIds: ids,
    window: { timeMin: min.toISOString(), timeMax: max.toISOString() },
    busy: busy.map(iso),
    free: free.map(iso),
    ...(errors.length ? { errors } : {}),
  };
}

async function buildTimes(calendar, calendarId, { start, end, timeZone }) {
  if (!start) return {};
  if (isDateOnly(start)) {
    if (end && !isDateOnly(end)) throw new Error('An all-day event needs a YYYY-MM-DD end.');
    return { start: { date: start }, end: allDayEnd(start, end) };
  }
  if (!end) throw new Error('A timed event needs both start and end.');
  const tz = timeZone ?? (await calendarTimeZone(calendar, calendarId));
  return { start: toEventTime(start, tz), end: toEventTime(end, tz) };
}

async function createEvent(args) {
  const {
    calendarId = 'primary', summary, description, location, attendees, recurrence,
    reminderMinutes, colorId, sendUpdates = 'none',
  } = args;
  if (!summary) throw new Error('summary is required.');
  const resolvedColor = resolveColorId(colorId);
  const calendar = calendarClient();
  const times = await buildTimes(calendar, calendarId, args);
  const requestBody = {
    summary,
    description,
    location,
    ...times,
    ...(asArray(attendees).length ? { attendees: asArray(attendees).map((email) => ({ email })) } : {}),
    ...(asArray(recurrence).length ? { recurrence: asArray(recurrence) } : {}),
    ...(asArray(reminderMinutes).length
      ? { reminders: { useDefault: false, overrides: asArray(reminderMinutes).map((m) => ({ method: 'popup', minutes: m })) } }
      : {}),
    ...(resolvedColor ? { colorId: resolvedColor } : {}),
  };
  const { data } = await calendar.events.insert({ calendarId, sendUpdates, requestBody });
  return { status: 'created', sendUpdates, event: formatEvent(data, calendarId) };
}

async function updateEvent(args) {
  const { eventId, calendarId = 'primary', summary, description, location, attendees, colorId, sendUpdates = 'none' } = args;
  if (!eventId) throw new Error('eventId is required.');
  const resolvedColor = resolveColorId(colorId);
  if ((args.start && !args.end) || (!args.start && args.end)) {
    throw new Error('Pass start and end together when changing the time.');
  }
  const calendar = calendarClient();
  const times = await buildTimes(calendar, calendarId, args);
  const requestBody = {
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(location !== undefined ? { location } : {}),
    ...times,
    ...(attendees !== undefined ? { attendees: asArray(attendees).map((email) => ({ email })) } : {}),
    ...(resolvedColor ? { colorId: resolvedColor } : {}),
  };
  if (Object.keys(requestBody).length === 0) throw new Error('Nothing to change: pass at least one field.');
  const { data } = await calendar.events.patch({ calendarId, eventId, sendUpdates, requestBody });
  return { status: 'updated', changed: Object.keys(requestBody), sendUpdates, event: formatEvent(data, calendarId) };
}

async function deleteEvent({ eventId, calendarId = 'primary', sendUpdates = 'none' }) {
  if (!eventId) throw new Error('eventId is required.');
  const calendar = calendarClient();
  const { data: before } = await calendar.events.get({ calendarId, eventId });
  await calendar.events.delete({ calendarId, eventId, sendUpdates });
  return { status: 'deleted', sendUpdates, event: formatEvent(before, calendarId) };
}

async function respondToEvent({ eventId, response, comment, calendarId = 'primary', sendUpdates = 'all' }) {
  if (!eventId) throw new Error('eventId is required.');
  if (!['accepted', 'declined', 'tentative'].includes(response)) {
    throw new Error('response must be accepted, declined or tentative.');
  }
  const calendar = calendarClient();
  const { data: event } = await calendar.events.get({ calendarId, eventId });
  const attendees = event.attendees ?? [];
  const me = attendees.find((a) => a.self);
  if (!me) throw new Error('The account is not listed as an attendee of this event, so there is nothing to respond to.');
  const updated = attendees.map((a) =>
    a.self ? { ...a, responseStatus: response, ...(comment !== undefined ? { comment } : {}) } : a
  );
  const { data } = await calendar.events.patch({
    calendarId,
    eventId,
    sendUpdates,
    requestBody: { attendees: updated },
  });
  return { status: `responded ${response}`, attendee: me.email, sendUpdates, event: formatEvent(data, calendarId) };
}

const HANDLERS = {
  list_calendars: listCalendars,
  list_events: listEvents,
  search_events: searchEvents,
  get_event: getEvent,
  find_free_time: findFreeTime,
  create_event: createEvent,
  update_event: updateEvent,
  delete_event: deleteEvent,
  respond_to_event: respondToEvent,
};

const server = new Server({ name: 'calendar-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Reject arguments the tool does not declare, instead of silently dropping them.
// Without this, a call using the wrong spelling for a parameter (snake_case for a
// camelCase name, say) succeeds against the defaults and returns plausible data for
// something the caller never asked for. Silent wrong data is worse than an error.
function validateArgs(tool, args) {
  const allowed = Object.keys(tool.inputSchema?.properties ?? {});
  const canon = (k) => k.toLowerCase().replace(/[_-]/g, '');
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    const detail = unknown.map((k) => {
      const hit = allowed.find((a) => canon(a) === canon(k));
      return hit ? `${k} (did you mean ${hit}?)` : k;
    });
    throw new Error(
      `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${detail.join(', ')}. ` +
      `${tool.name} accepts: ${allowed.join(', ') || '(none)'}.`
    );
  }
  const missing = (tool.inputSchema?.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length) {
    throw new Error(`Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = HANDLERS[request.params.name];
  const tool = TOOLS.find((t) => t.name === request.params.name);
  if (!handler || !tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  try {
    const args = request.params.arguments ?? {};
    validateArgs(tool, args);
    const result = await handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const detail = e.response?.data?.error?.message;
    return { content: [{ type: 'text', text: `Error: ${detail ? `${e.message} (${detail})` : e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
