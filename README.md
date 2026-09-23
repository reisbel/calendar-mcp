# calendar-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for one Google Calendar account, served over stdio.
It gives an MCP client such as Claude Code the ability to list, search, and create events, find free time, and answer invitations using your own Google OAuth client.

## Why

Google's hosted Calendar MCP endpoint requires the Cloud project to be enrolled in the Google Workspace Developer Preview Program, which asks for a Workspace account.
A personal Google account cannot use it.
This server sidesteps that by talking to the Calendar API itself with a Desktop-app OAuth client that you create in your own Google Cloud project.
No third party sits between the client and your calendar.

## Scope and safety

The server requests two scopes, `calendar.readonly` and `calendar.events`: read everything, write events, answer invitations.
It cannot create or delete calendars or change who a calendar is shared with.

Reading is harmless.
The four write tools change a calendar that other people may see and can email them, so pin them to an "ask" rule in your MCP client so they prompt on every call regardless of the session's permission mode.
In Claude Code that is a block in `.claude/settings.local.json` of the project where the server is registered:

```json
{
  "permissions": {
    "ask": [
      "mcp__calendar__create_event",
      "mcp__calendar__update_event",
      "mcp__calendar__delete_event",
      "mcp__calendar__respond_to_event"
    ]
  }
}
```

The tool name prefix is `mcp__<server name>__`, so adjust it to whatever name you register the server under.

Every write tool takes `sendUpdates`, which controls whether Google emails attendees.
Create, update and delete default to `none`, so nobody is notified unless you ask.
Respond defaults to `all`, because the point of an RSVP is that the organizer hears about it.

## Tools

| Tool | Effect |
| --- | --- |
| `list_calendars` | Calendars visible to the account, with ids, access roles and time zones |
| `list_events` | Events in a window, recurring events expanded. Defaults to the primary calendar and the next 7 days |
| `search_events` | Free-text search across titles, descriptions, locations and attendees. Defaults to a two-year window |
| `get_event` | One event in full |
| `find_free_time` | Busy blocks and free gaps across one or more calendars inside a window |
| `create_event` | **Writes.** Timed or all-day, optional attendees, recurrence, reminders and colour |
| `update_event` | **Writes.** Changes only the fields passed, colour included |
| `delete_event` | **Writes. Irreversible.** Returns the event as it was before deletion |
| `respond_to_event` | **Writes.** Accept, decline or tentatively accept an invitation |

Time inputs are RFC 3339 timestamps such as `2026-09-13T09:00:00-04:00`.
A bare `YYYY-MM-DD` start makes an all-day event.
A timestamp without an offset is interpreted in `timeZone` when given, otherwise in the calendar's own time zone.

`colorId` on create and update takes Google's fixed event palette by name or number: 1 Lavender, 2 Sage, 3 Grape, 4 Flamingo, 5 Banana, 6 Tangerine, 7 Peacock, 8 Graphite, 9 Blueberry, 10 Basil, 11 Tomato.
Every event the server returns carries `colorId` and its `color` name, so a change can be checked in the same call.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | The MCP server |
| `colors.js` | Google's fixed event palette and the `colorId` resolver |
| `colors.test.js` | Unit tests for the resolver, run with `npm test` |
| `auth.js` | One-time OAuth consent flow; writes the token file |
| `config.js` | File locations and scopes, overridable through environment variables |
| `credentials.json` | OAuth client from Google Cloud Console. Gitignored, never commit it |
| `token.json` | Refresh token, written with mode 600. Gitignored, never commit it |

## Setup

Requires Node.js 20 or newer.

1. In [Google Cloud Console](https://console.cloud.google.com), signed in as the Google account you want to expose: create a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen as **External** and add that same account as a **test user**.
3. Create an **OAuth client ID** of type **Desktop app** and download its JSON to `credentials.json` in this directory.
   If you already have a Desktop client from another tool in the same project, the same file works here; each server keeps its own token.
4. Install dependencies and run the consent flow:

   ```sh
   npm install
   npm run auth
   ```

   A browser opens on the Google consent screen.
   When it finishes, the script prints which account the token belongs to.
   Set `CALENDAR_MCP_ACCOUNT` to the expected address if you want a warning when the wrong account was used.
5. Register the server with your MCP client.
   For Claude Code, from the project where you want it available:

   ```sh
   claude mcp add calendar -- node /absolute/path/to/calendar-mcp/server.js
   ```

## Configuration

Everything defaults to files next to the code.
Override with environment variables when the server runs from elsewhere or when several accounts share one checkout.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CALENDAR_MCP_CREDENTIALS` | `./credentials.json` | Path to the OAuth client JSON |
| `CALENDAR_MCP_TOKEN` | `./token.json` | Path where the refresh token is stored |
| `CALENDAR_MCP_ACCOUNT` | unset | Expected address; `auth.js` warns if the token belongs to another account |

To change the scopes, edit `SCOPES` in `config.js` and re-run `npm run auth`.
An existing token keeps its old scopes, and API calls fail with `insufficient authentication scopes` until it is reissued.

## Notes

- Staying in OAuth "Testing" status is fine for personal use; no Google verification is needed.
  Refresh tokens for an app in **Testing** status expire **7 days after they are
  issued**, whether or not the app is used. This is not an idle timeout: a token
  used every single day still stops working on day 7.
  Re-run `npm run auth` when calls start failing with `invalid_grant`.
- `credentials.json` and `token.json` are secrets.
  They are gitignored here, but treat any copy of them like a password.
- A sibling project, [gmail-mcp](https://github.com/reisbel/gmail-mcp), does the same for Gmail.

## License

MIT. See `LICENSE`.
