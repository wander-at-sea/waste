# sevenoaks-waste-collection

A single public page that shows the next fortnightly garden waste
collection day for **TN13 3AB, 17 The Drive**, sourced live from the
[Sevenoaks District Council collection day
checker](https://sevenoaks-dc-host01.oncreate.app/w/webpage/waste-collection-day).

## How it works

- `index.html` — static page. On load it calls `/api/collection-day` and
  displays the result.
- `api/collection-day.js` — a Vercel serverless function that drives
  headless Chromium (`puppeteer-core` + `@sparticuz/chromium`) against the
  council page: enters the postcode, waits for the address dropdown/list
  to appear, selects "17 The Drive", waits for the result, and extracts
  the text under "Fortnightly garden waste collection".

The postcode and address are hardcoded constants at the top of
`api/collection-day.js` — edit those to point at a different address.

If a lookup fails, the page shows which step failed and (when available)
a screenshot of the council site at that point, since the site's markup
wasn't inspectable from the environment this was originally built in.

## Deploying

Import this repo at [vercel.com/new](https://vercel.com/new) — the "Other"
framework preset works with no build step. `vercel.json` sets the
function's timeout (60s) and memory (1.5GB), since a headless-browser
lookup can take 15-40 seconds.

## Local testing

There's no dev server for the static file, and `/api` functions need
Vercel's runtime. Install the Vercel CLI and run `vercel dev`.
