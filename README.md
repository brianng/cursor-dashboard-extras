# Cursor Dashboard Extras

Chrome extension (Manifest V3) that augments [Cursor](https://cursor.com) dashboard pages while you are signed in.

## Features

- **Usage** (`/dashboard/usage`): click a usage row to open a side panel with a token/cost summary and raw JSON from Cursor’s dashboard API.
- **Spending** (`/dashboard/spending`): shows a **Daily Usage Pace** overlay with 1P and API columns (current pace vs budget pace per pool) from `/api/usage-summary`.

All requests stay **same-origin** on `cursor.com`; the extension does not send data elsewhere.

## Install (load unpacked)

1. Open Chrome → **Extensions** (`chrome://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** and choose this repository folder (the one containing `manifest.json`).

Reload the extension after you change files during development.

## Requirements

- Chromium-based browser with MV3 support.
- A logged-in Cursor session on `https://cursor.com` so dashboard API calls succeed.

## Limitations

Dashboard markup and API responses can change; the extension may need updates when Cursor ships UI or API changes. Selector and parsing details live in `content.js` (for example usage row detection, timestamp parsing, and the spending overlay).
