# CGI Project Overview

**Repository:** `skerishKang/kbs261022`
**Customer:** CGI (주식회사 시지아이), 김범신 대표
**Developer:** PADIEM
**Brand (customer-facing):** CGI
**Master issue:** #119
**Baseline main SHA:** `0b84dc76af0bb40c08c972a7449b084374a0ce92`
**Last updated:** 2026-10-27 KST

## 1. What CGI is

CGI is an independent commerce system for 주식회사 시지아이: a public product
catalog site, a member/authenticated storefront with quote/order/payment/refund
flows, an Ecount ERP sync layer, a Naver Smart Store registration pipeline, and
an admin console. It is developed by PADIEM but is a CGI-branded product. PADIEM
Chat and PADIEM Claw are separate products and are not part of CGI.

## 2. Stack

- Frontend: static HTML/CSS/JS under `site/`, deployed to GitHub Pages
  (`https://skerishkang.github.io/kbs261022/site/`).
- Backend: Cloudflare Worker (`cgi-quote-api`, `worker.js`) + D1 database
  (`cgi_quotes`), deployed at `https://cgi-quote-api.charliekant.workers.dev`.
- Auth: member-based sessions (cookie `cgi_member`), superadmin/admin roles.
- Payments: Toss Payments (sandbox verified).
- ERP: Ecount (test mode, no live write).
- Naver Smart Store: registration prep only (approval pending).

## 3. Feature areas

| Area | Location | Status |
|---|---|---|
| Product catalog (4,575 items) | `site/index.html`, `site/data/products.js` | IMPLEMENTED/DEPLOYED |
| Company website | `website/` | IMPLEMENTED/DEPLOYED |
| Member auth (signup/login/Google OAuth) | `backend/worker.js`, `site/assets/js/cgi-auth.js` | IMPLEMENTED/TESTED/DEPLOYED |
| Quote/order/payment/refund | `backend/worker.js`, `site/orders.html` | IMPLEMENTED/TESTED/DEPLOYED |
| Admin console (orders, staff, sync) | `site/staff.html`, `site/sync.html` | IMPLEMENTED/TESTED/DEPLOYED |
| Ecount ERP modules | `backend/lib/erp*.mjs` | IMPLEMENTED/TESTED |
| Naver Smart Store prep | `backend/lib/naver-*.mjs`, `tools/` | IMPLEMENTED/TESTED |
| Product sync engine (change-detect, sync-state, sync-engine, duplicate-match) | `backend/lib/*sync*.mjs`, `backend/lib/change-detect.mjs`, `backend/lib/erp-duplicate-match.mjs` | IMPLEMENTED/TESTED/DEPLOYED |
| D1 migration 0005 (product_sync_state, product_change_log) | `backend/migrations/0005_product_sync_state.sql` | DEPLOYED |
| Google OAuth | `backend/lib/google-oauth.mjs` | IMPLEMENTED/TESTED/DEPLOYED |
| Email verification (SendGrid/Resend) | `backend/lib/mail.mjs` | IMPLEMENTED/TESTED |

## 4. Entry points

- Master issue: #119
- Admin sync UI: https://skerishkang.github.io/kbs261022/site/sync.html
- Worker health: https://cgi-quote-api.charliekant.workers.dev/api/admin/health
- Product catalog: https://skerishkang.github.io/kbs261022/site/

## 5. Brand boundary

CGI customer-facing surfaces use the CGI brand. PADIEM/PADIEM Chat/PADIEM Claw
appear only as developer attribution where appropriate, never as the product
brand. Scan (2026-10-27) found no `PADIEM Chat/Claw/Connector` references in
`site/` customer-facing code or `docs/`.
