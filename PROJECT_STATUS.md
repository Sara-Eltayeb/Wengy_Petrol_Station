# Wengy FuelGuard AI

## Current State

- Premium responsive dashboard is implemented in `index.html` and `styles.css`.
- Dashboard is served by `server.js` at `http://localhost:3000`.
- Google Sheets CSV data is connected and populates Petrol and Diesel KPIs.
- Mon Plein Pas Cher Diesel market API is connected and returns live JSON.
- Gemini is server-side only. The key is loaded from `.env` and is never sent to frontend JavaScript.
- Five agent personas are stored in `agents/`.
- Gemini handoff order is Researcher, Designer, Maker, Marketer, Manager.
- Pipeline evidence is written to `data/runs/` after a complete run.
- Gemini uses the standard `generateContent` endpoint and extracts candidate text into the saved run evidence.

## Start

```powershell
npm start
```

Open `http://localhost:3000` and click `Run AI pipeline`.

## Environment

Configure `.env` locally. Never commit it or share the key.

```env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=
GOOGLE_SHEETS_API_URL=your_sheet_csv_url
FRENCH_MARKET_API_URL=your_market_json_url
```

## Current Blocker

The replacement Gemini key is working and a complete five-agent run is saved in `data/runs/latest.json`. The French market API is free and connected for Gazole; when `FRENCH_MARKET_PETROL_API_URL` is blank, the server derives the same endpoint with `fuel=e10`, so Petrol pricing is also available. Quota failures still return HTTP 429 from the local server.

## Important Notes

- `--` and `Unavailable` are intentional when a source has no verified response.
- A normal Google Sheets sharing URL will not work. Use a published CSV URL or a server-side Sheets API endpoint.
- Do not hardcode live fuel, supplier, market, or agent results.
- After changing `.env`, stop and restart `npm start`.
