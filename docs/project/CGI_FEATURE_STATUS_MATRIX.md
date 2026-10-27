# CGI Feature Status Matrix

**Repository:** `skerishKang/kbs261022`
**Baseline main SHA:** `0b84dc76af0bb40c08c972a7449b084374a0ce92`

Legend: IMPLEMENTED = code exists; TESTED = tests pass; DEPLOYED = live deploy confirmed; LIVE_VERIFIED = real-environment check done.

| Feature | Implemented | Tested | Deployed | Live verified |
|---|---|---|---|---|
| Product catalog (4,575) | yes | yes (site tests) | yes (Pages) | yes |
| Company website | yes | yes | yes (Pages) | yes |
| Member auth (signup/login/Google OAuth) | yes | yes (e2e) | yes | partial |
| Quote/order/payment/refund | yes | yes (e2e) | yes | partial (Toss sandbox) |
| Admin console (orders, staff) | yes | yes (e2e) | yes | yes |
| Admin sync UI (sync.html) | yes | yes (site) | yes | page render yes, API 401 (non-admin) |
| Ecount ERP modules (test mode) | yes | yes (unit/e2e) | yes | no (keys missing) |
| Naver Smart Store prep | yes | yes (unit) | yes | no (approval pending) |
| Product sync engine (change-detect, sync-state, sync-engine, duplicate-match) | yes | yes (unit) | yes | no (0 rows) |
| D1 migration 0005 | yes | yes (CI) | yes | yes (table exists) |
| Google OAuth | yes | yes (e2e) | yes | partial |
| Email verification (Resend) | yes | yes (e2e) | yes | partial |
| NICEPAY protocol + sandbox | yes | yes (unit/e2e) | yes | sandbox only |
| ERP integration CI gate | yes | yes (CI) | yes | yes |
| Returns/refund policy page | yes | yes (site) | yes | yes |
| Company profile 2025 info | yes | yes | yes | yes |
| Procurement bid analysis | yes | yes | yes | partial |
| Customer auth separated from PADIEM | yes | yes | yes | yes |

## Not implemented / deferred

- Live Naver product registration (approval pending).
- Live Ecount item registration / stock change (keys missing).
- Live PG (NICEPAY) production keys.
- Full product sync state population (dry-run not executed).
- CGI AI features (see CGI_AI_INTEGRATION_ROADMAP.md).
