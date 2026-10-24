# RouteGuard

Weather-aware route planning built with React, Vite, Leaflet, and a small Express API proxy for Gemma-compatible providers.

## Run the app

Install dependencies once, then run the web app and API together:

```powershell
npm install
npm start
```

The Vite app is available at `http://localhost:5175` and the API health endpoint at `http://localhost:8000/api/health`.

If you only want the route planner, use `npm run dev`. Route geocoding and sampled waypoint labels use OpenStreetMap Nominatim, driving distances use the public OSRM demo service, and weather uses Open-Meteo. The waypoint-label proxy caches results and spaces reverse lookups to respect Nominatim's public-service limits. These services require an internet connection and have their own availability and usage limits.

## Configure Gemma 4

The Gemma key stays on the server and is never sent to the browser. Copy `.env.example` to `.env` and set:

- `GEMMA_API_KEY`: a key for that provider.
- `GEMMA_MODEL`: a Gemma 4 model identifier supported by that provider.
- `FRONTEND_ORIGIN`: normally `http://localhost:5175`.
- `VITE_ROUTE_API_BASE_URL`: browser-safe URL for the route API, normally `http://localhost:8000/api`.

The app does not bundle a provider key. Google currently lists `gemma-4-26b-a4b-it` and `gemma-4-31b-it` as Gemma models supported by the Gemini API; use the exact model ID enabled for your key.

After editing `.env`, restart `npm start`. Check `http://localhost:8000/api/health`; `providerConfigured` should be `true`. Then analyze a route and select **Generate AI travel briefing**.

The server calls Google's native Gemini `generateContent` endpoint for the configured Gemma model. Never commit `.env` or place provider keys in `VITE_*` variables. `.env` is excluded from Git; use `.env.example` as the safe template.

## Current routing scope

Route calculations currently use OSRM driving directions; the displayed distance comes from the OSRM route response. Intermediate weather points are sampled evenly by route distance and reverse-geocoded to the nearest mapped road/place. If no name is available, the UI shows the sampled coordinate. Open-Meteo current conditions are model-derived snapshots; route-arrival values are forecasts for the sampled coordinates, not roadside sensor observations. Cycling and walking options are labeled as estimates because separate route providers have not been configured. Forecast risk describes sampled weather estimates, not road-condition reports or official safety alerts.
