# CGI order to ECOUNT Open API

## Existing state and changes

The repository already contained an ECOUNT Open API V2 transport, Zone discovery, login/session handling, SaleOrder payload planning, and the `erp_sync` D1 retry/audit table. The Worker payment path still used a legacy placeholder adapter, and the existing ECOUNT item codes were proposals rather than verified ERP master codes. There was no approved online customer or warehouse mapping.

Relevant inventory reviewed: `backend/lib/erp-oapi.mjs` contains the Open API transport; `backend/lib/erp-plan.mjs` validates the vendor SaleOrder rows; `backend/lib/erp.mjs` was the Worker placeholder; `backend/lib/erp-client.mjs` and `backend/lib/erp-order-sync.mjs` are older service wrappers that are not used by the Worker payment route. `backend/schema.sql` and `backend/migrations/0001_order_payment_schema.sql` already define `erp_sync`, including a unique `dedupe_key`. `docs/CGI_ECOUNT_ERP_PREP.md` and `backend/lib/erp-linkage-plan.mjs` record the item-code reconciliation work; that evidence found no exact CGI-to-ECOUNT code matches, so proposed checkout codes cannot be treated as verified. `.env.example` previously named `ECOUNT_PASSWORD`; the Open API instead uses `ECOUNT_API_CERT_KEY`.

The Worker now records a durable, order-ID keyed claim in `erp_sync` before any ECOUNT request. A paid order can create one SaleOrder request containing up to 50 mapped lines. Duplicate payment callbacks and admin retries reuse that claim. An ambiguous result after the write request begins is marked `unknown` and is blocked from blind resend; reconcile it in ECOUNT before any manual recovery. Payment completion stays successful if ERP configuration, persistence, or transmission fails.

When the switch is off, secrets are missing, or any customer, warehouse, item, or shipping mapping is missing, the Worker records `not_configured`, with zero attempts and no outbound request. Customer contact/address details and credentials are not written to the ERP receipt. Product mappings must be exact approved ECOUNT `PROD_CD` values keyed by CGI `product_id`; the checkout `erp_code` proposal is not trusted.

## Required bindings and non-secret configuration

Secrets (values are intentionally absent from this repository):

- `ECOUNT_COM_CODE`
- `ECOUNT_USER_ID`
- `ECOUNT_API_CERT_KEY`

`ECOUNT_ZONE` is not required; the adapter discovers the zone through the Open API Zone endpoint. Configure these non-secret values after confirming them with the ECOUNT account owner:

- `ECOUNT_ORDER_SYNC_ENABLED=NO` (switch; set to `YES` only during the test step below)
- `ECOUNT_TARGET=test` (use `prod` only for the production step)
- `ECOUNT_DEFAULT_CUST_CODE` (approved online sales customer code)
- `ECOUNT_DEFAULT_WH_CD` (approved warehouse code)
- `ECOUNT_ITEM_CODE_MAP_JSON` (JSON object mapping each CGI product ID to an approved ECOUNT product code)
- `ECOUNT_SHIPPING_ITEM_CODE` (required when an order has a non-zero shipping fee)

Never derive the customer code from a buyer's name, email, phone, or address. Do not enable order sync until every item in a paid order has a verified product mapping.

## Key issuance and activation order

1. Issue the Open API certificate key in the ECOUNT account. Bind the three secrets above to the **test Worker** without putting values in Git, logs, or chat.
2. Set the approved customer, warehouse, product, and shipping mappings on the test Worker. Keep `ECOUNT_TARGET=test` and set `ECOUNT_ORDER_SYNC_ENABLED=YES` only for a controlled test order.
3. Confirm that the test order is paid, the staff order page shows the ERP send status, `erp_sync` has one `sent` receipt, and the matching SaleOrder exists in the ECOUNT test company. Check the product quantities, prices, customer, warehouse, and shipping line.
4. After the test is accepted, set the test switch back to `NO`, bind production credentials separately, set `ECOUNT_TARGET=prod`, verify the production mappings, and enable `ECOUNT_ORDER_SYNC_ENABLED=YES` on the production Worker.
5. Confirm one production order against the ECOUNT SaleOrder and the staff order status. Keep the switch `NO` to disable future sends.

The repository tests use only a loopback mock with fabricated responses. No ECOUNT server was contacted for this change. ECOUNT documents the Open API as supporting online order registration through sales-order/sales input, requires Zone then login/session use, and requires a new login after session expiry: [Open API overview](https://www.ecount.com/my/ecount/product/erp_open-api), [login API FAQ](https://www.ecount.com/kr/ecount/service/faq-view?category=erp&page=13&record_sid=8717N5PMISI7MD6), [session expiry FAQ](https://www.ecount.com/kr/ecount/service/faq-view?page=514&record_sid=7WCGSHOID1A1GFV).
