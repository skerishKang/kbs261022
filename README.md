# CGI Online Sales & ERP Integration

CGI's shopping mall (`site/`), company homepage (`website/`) and Cloudflare backend
(Worker + D1). The project is developed through visible GitHub issues, independent
pull requests, review, and CI.

## Scope
1. CGI product catalog and website-to-store purchase path.
2. Naver Smart Store / Ecount ERP integration where supported (order sync stays off
   until the operating keys and approval are in place).
3. One real product data flow, with test evidence and explicitly stated
   external-account dependencies.
4. Record CI results and deployment evidence for every change.

## Delivery boundary
The storefront, member accounts, quote intake and NICEPAY **TEST** payments are live at
https://cgishop.pages.dev/site/. Operating payment keys, ECOUNT live write, and the
public domain are still pending. Payments show a `TEST 결제` badge until the operating
keys are enabled. No fabricated orders or claims of live integration without evidence.

Deployment procedure: [docs/CGI_DEPLOYMENT.md](docs/CGI_DEPLOYMENT.md).

## Development
- Base branch: main
- Independent feature branches and PRs for separable work
- Do not commit credentials, customer data, internal governance, or recorded calls
- Existing ai-revenue-lab/B71 work is a reference, not proof that this PoC is complete