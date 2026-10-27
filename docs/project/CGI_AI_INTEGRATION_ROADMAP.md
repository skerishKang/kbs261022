# CGI AI Integration Roadmap

**Repository:** `skerishKang/kbs261022`
**Master issue:** #119

## 1. Principle

CGI AI features are CGI-native: they run inside the CGI homepage/store/ERP
system and use CGI data. PADIEM Chat and PADIEM Claw are separate products and
are not embedded as the CGI product. Existing PADIEM technology may be reused
internally, but CGI users must not be required to sign up for a separate
PADIEM service.

## 2. Customer-facing AI (homepage/store)

| Feature | Reuse candidate | Status |
|---|---|---|
| Product search & recommendation | `site/data/products.js`, catalog search | Candidate (not implemented) |
| Spec comparison across equipment | Product master schema | Candidate |
| Natural-language quote request | Quote backend (`/api/quotes`) | Candidate |
| Auto quote generation | `quote` module + product price index | Candidate |
| Order/delivery status Q&A | Order API (`/api/me/orders`) | Candidate |
| Product/return policy Q&A | `site/returns.html`, policy docs | Candidate |

## 3. Staff/admin AI

| Feature | Reuse candidate | Status |
|---|---|---|
| Ecount product/stock lookup | `backend/lib/erp*.mjs`, erp_sync table | Candidate |
| Stock shortage / price change analysis | sync-engine, change-detect | Candidate |
| Order/quote/shipment summary | Order API, admin console | Candidate |
| Catalog authoring assistance | product master schema, issue #43 | Candidate |
| Customer inquiry classification | Member/auth, mail module | Candidate |
| ERP workflow automation | erp-plan, erp-duplicate-match | Candidate (guarded by auth + audit log) |

## 4. Guardrails

- AI that changes ERP data reuses existing permission verification and audit logs.
- No external AI service signup required for CGI users.
- Model/agent changes require owner approval (per PADIEM policy).
- External product registration/stock writes remain disabled until approval.

## 5. Reuse estimate

High reuse for: product search, quote generation, order status, catalog authoring.
Medium reuse for: stock analysis, inquiry classification.
Low reuse (new work): natural-language orchestration layer, model hosting.
