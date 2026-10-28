# CGI Development History

**Repository:** `skerishKang/kbs261022`
**Master issue:** #119
**Baseline main SHA:** `0b84dc76af0bb40c08c972a7449b084374a0ce92`

## 1. Timeline (high level)

- 2026-10-22: Repository initialized (`351ef75`). Issues #1 (ERP PoC), #2 (docs), #5 (site analysis), #7 (infra handoff), #8 (product master), #9 (docs/ops), #11 (catalog demo), #18 (company website), #19 (full catalog DB), #20 (ERP account analysis) opened and rapidly closed via PRs #10-#36.
- 2026-10-23: Issues #33 (procurement), #37 (quote), #39 (quote backend), #43 (catalog data QA), #50 (procurement P1), #52 (admin auth/CORS). PRs #38-#64 merged. Cloudflare Worker/D1 quote backend scaffolded (#40, #42, #44). Customer auth separated from PADIEM (#69 merged 10-25).
- 2026-10-24: Order/payment/admin console (#67, #68, #70, #72-75). Toss Payments sandbox E2E (#71-74). Customer auth + Google OAuth (#69, #79, #80, #81, #85).
- 2026-10-25: Admin member management (#76, #77, #84), refund floor/repay (#87, #88), CORS cookie admin (#86), payment tests. Naver/Ecount prep (#34, #31, #58). Product quality QA (#43, #46, #47, #51).
- 2026-10-26: Profile/company info (#97, #98, #99), catalog encoding fix (#55), procurement test sandbox (#63), returns/refund page (#102, #103), PG comparison (#106, #112-#117), NICEPAY integration (#113, #115, #116, #117, #120).
- 2026-10-27: Product sync engine recovery (#104), Phase 3 admin sync UI (#105), sync auth flow (#110), CORS fix (#107), ERP integration CI gate (#118), NICEPAY sandbox deployment config (#120), issue #119 master.

## 2. Key merged PRs (selected)

| PR | Title | Issue |
|---|---|---|
| #29 | ERP integration analysis | #20 |
| #28 | Full 4,575-product catalog | #19 |
| #17 | Catalog site | #11 |
| #40/#42/#44 | Quote backend + frontend | #39 |
| #68 | Order/payment/admin/ERP sync queue | #67 |
| #69/#70 | Customer auth | #69 |
| #71-#74 | Toss sandbox E2E | #71 |
| #77/#84 | Superadmin/admin roles | #76 |
| #94 | Ecount OAPI V2 / Naver Commerce contract | #1 |
| #96 | 4,575 registration readiness | #95 |
| #100 | Dry-run 4,575 packages, 0 transmissions | #1 |
| #102/#103 | Returns/refund policy page | #102 |
| #104 | Sync engine recovery | #101 |
| #105 | Phase 3 admin sync UI | #1 |
| #110 | Sync auth flow | #1 |
| #113-#117,#120 | NICEPAY protocol + deployment | #106 |
| #118 | ERP integration CI gate | #118 |

## 3. Open items

- #1 (ERP PoC) — ongoing, scope includes sync engine + admin UI.
- #101 (sync) — open, Phase 1-3 merged, operational verification pending admin session.
- #106 (PG) — open, NICEPAY sandbox wired, live keys pending.
- #119 (master) — open.
- PR #30, #24, #23, #15, #14, #13, #12, #6, #4, #3 — open (docs/research, non-blocking).

## 4. Evidence sources

Git commits, PR merge timestamps, Actions runs, and the docs/ directory are the
source of truth. No fabricated timelines.
