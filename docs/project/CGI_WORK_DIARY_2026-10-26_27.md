# CGI Work Diary — 2026-10-26 / 2026-10-27

**Repository:** `skerishKang/kbs261022`
**Timezone:** KST
**Source:** Git commits, PR merge timestamps, Actions runs (approximate where logs unavailable).

## 2026-10-26

- 00:00-02:00 (est.): Profile/company info, procurement test sandbox, catalog encoding fixes merged (PRs #97-#99, #55, #63).
- 02:48: PR #100 merged — dry-run registration package of 4,575 products, 0 transmissions (#1).
- 03:43: PR #102/#103 merged — returns/refund policy page + shopping mall footer link (#102).
- 04:00-06:00 (est.): PG market comparison docs (#112, #114) and PayApp feasibility (#109).
- 06:36-08:11: NICEPAY protocol layer + sandbox + window + webhook (#113, #115, #116, #117) merged.
- 08:50: ERP integration CI gate (#118) merged.
- 09:18: Master issue #119 opened.
- 09:50: NICEPAY sandbox deployment config + CORS origins (#120) merged.

## 2026-10-27

- 01:41: Returns policy page merged (#103).
- 02:38: Sync engine recovery PR #104 merged (change-detect, sync-state, sync-engine, erp-duplicate-match, migration 0005, #101 doc corrections).
- 02:53: Phase 3 admin sync UI PR #105 merged (sync/status, sync/products, sync/retry endpoints + sync.html).
- 03:27: Sync admin API base fix PR #107 merged.
- 03:31: PR #108 (CORS base change) closed — broke customer-auth test; existing wrapper retained.
- 03:38: Sync auth flow PR #110 merged.
- 04:15-04:18: PG comparison docs (#112, #114) merged.
- 06:36-08:11: NICEPAY protocol + sandbox + deployment (#113, #115, #116, #117, #120) merged.
- 08:50: ERP integration CI gate (#118) merged.
- 09:50: NICEPAY sandbox deployment config (#120) merged.

## Notes

- Token usage is not tracked in this repository; only wall-clock/commit time is recorded.
- External writes (Naver product registration, Ecount live writes) were NOT performed.
- D1 migration 0005 applied to production `cgi_quotes` (product_sync_state, product_change_log).
- Worker deployed at `https://cgi-quote-api.charliekant.workers.dev` (version 0b84dc7 baseline).
- GitHub Pages live at `https://skerishkang.github.io/kbs261022/site/sync.html`.
