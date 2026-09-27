# Test fixtures

- `ol-search-fantasy.json`, `ol-work-psych-money.json`, `ol-editions-psych-money.json` — real Open Library API
  responses captured on 2026-09-27 (Open Library data is openly licensed; used here for tests only).
- `gb-volumes-psych-money.json` — a Google Books `volumes` response **constructed by hand** to match the documented
  API schema (the anonymous Google Books quota was 0 when fixtures were captured). Values are illustrative test data,
  not catalog data, and never enter the catalog.
- `paapi-searchitems.json` — a PA-API 5 `SearchItems` response **constructed by hand** from Amazon's documented
  response schema, for the same reason (no credentials available).
