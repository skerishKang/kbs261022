# ECOUNT item mapping test fixtures

These files contain 30 fabricated ERP items and are not an ECOUNT export. Item codes and barcodes are fake. A few item names deliberately reuse current public shop catalog names so matching and normalization can be exercised. `shop_products.json` uses synthetic product IDs and model/barcode values.

- `fake_items_korean.csv`: Korean export-style column names.
- `fake_items_api_fields.xlsx`: ECOUNT Open API field names.
- `shop_products.json`: synthetic cases for model priority, formatting variation, barcode match, score ties, no candidate, and a QU-7 number collision.

No customer, payment, or real ERP account data is included.
