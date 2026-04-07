# NodeNote Google Sheet Collaboration Backend

This folder contains the Google Apps Script backend used by NodeNote's Google Sheet co-edit mode.

## Setup

1. Create a Google Spreadsheet.
2. Open `Extensions -> Apps Script`.
3. Paste the contents of `NodeNoteSheetSync.gs` into the script editor.
4. Set optional script properties:
   - `NODENOTE_SPREADSHEET_ID` if the script is not bound to the spreadsheet.
   - `NODENOTE_SECRET` if you want a shared secret for the web app.
5. Deploy as a Web App:
   - Execute as: `Me`
   - Who has access: `Anyone` or `Anyone with the link`
6. Copy the `/exec` Web App URL into NodeNote's Cloud Sync panel.

## Sheets used

- `state`
- `nodes`
- `folders`
- `assets`

## Notes

- NodeNote sends collaborative patches, not raw keystrokes.
- The backend stores each entity as a JSON payload in the sheet.
- Remote updates are polled from the Web App, so the experience is near-real-time rather than websocket realtime.
