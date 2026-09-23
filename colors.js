/**
 * Google Calendar's fixed event palette.
 *
 * The API only takes the numeric id, but the names are what people see in the
 * UI, so the tools accept either. Kept apart from server.js so it can be
 * imported and tested without starting the server or reading credentials.
 */
export const EVENT_COLORS = Object.freeze({
  1: 'Lavender', 2: 'Sage', 3: 'Grape', 4: 'Flamingo', 5: 'Banana', 6: 'Tangerine',
  7: 'Peacock', 8: 'Graphite', 9: 'Blueberry', 10: 'Basil', 11: 'Tomato',
});

/** The palette as one line for error messages: "1 Lavender, 2 Sage, ...". */
export const PALETTE_TEXT = Object.entries(EVENT_COLORS).map(([id, name]) => `${id} ${name}`).join(', ');

/**
 * Resolve a colour given by number or name to the string id the API expects.
 * Returns undefined for undefined, so callers can pass the argument straight
 * through. Anything unrecognised throws with the full palette in the message.
 */
export function resolveColorId(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (EVENT_COLORS[text]) return text;
  const byName = Object.entries(EVENT_COLORS).find(([, name]) => name.toLowerCase() === text.toLowerCase());
  if (byName) return byName[0];
  throw new Error(`Unknown colorId "${value}". Use a name or number from: ${PALETTE_TEXT}.`);
}
