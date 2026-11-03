# CGI to ECOUNT item-code review workflow

## Current state

The shop catalog has 4,575 products. The repository does not contain the ECOUNT item export that the owner will provide, so this change does not generate or commit candidate rows or approved codes. Existing `product_sync_state` records transfer status and is not an item-code mapping table.

The new local tool reads an ECOUNT `.xlsx` or `.csv` export and `site/data/products.json`. It only writes a review CSV; it never contacts ECOUNT or D1. When a reviewed CSV is later sent to the Worker import route, only rows with an explicit value in the approval column are written to `ecount_item_mapping`. Test and production send modes read this table; unapproved products remain blocked in those modes. Existing explicit `ERP_MODE=mock` fixtures retain their JSON map fallback.

## Input fields and header inference

The parser recognizes the ECOUNT Open API item fields `PROD_CD` (item code), `PROD_DES` (item name), `SIZE_DES` (specification/model), `UNIT` (unit), and `BAR_CODE` (barcode), along with common English and Korean export-label variants. The code and name columns are needed to identify an item; specification, unit, and barcode are read when present. For `.xlsx`, the tool checks workbook sheets and searches the first 30 rows for a header. For `.csv`, it detects UTF-8/UTF-8 BOM and Korean legacy encodings.

These export labels are inferred from ECOUNT's Open API field names and item-management vocabulary. **The real export file must be checked before relying on the header aliases**, because the owner has not supplied it yet. The file's sheet, header row, and actual column labels may require an alias adjustment.

ECOUNT documents item-list APIs and the use of its item information in outside systems, while its item-management overview identifies specification, unit, manufacturer/model, and barcode as item information: [Open API overview](https://www.ecount.com/kr/ecount/product/erp_open-api), [item management](https://www.ecount.com/kr/ecount/product/inventory_item-management).

## Candidate generation

Run locally after the export arrives:

```powershell
python tools/ecount_item_mapping.py --ecount-file C:\private\ecount-items.xlsx --output C:\private\ecount-item-candidates.csv
```

The output contains one row per shop product, with its ID, name, model, up to three ECOUNT candidates, integer score, evidence, and a blank `승인` column. Match priority is model exact (`SIZE_DES`) first, barcode exact (`BAR_CODE`) second, then normalized name similarity. Manufacturer and other exact specification evidence can raise a name candidate's score. Candidate generation is advisory; it does not approve a mapping.

When reviewing in Excel, import the candidate code columns as **Text** so numeric-looking codes keep leading zeroes. For the ECOUNT source export, prefer text-formatted code and barcode columns; if Excel stored a numeric value without a zero-preserving format, missing leading zeroes cannot be reconstructed. Save the approved file as UTF-8 CSV when possible; the import route also accepts Windows Korean CSV encoding.

For each product to approve, write the selected candidate's exact ECOUNT item code into `승인`. Leave it blank to keep the product unmapped. The importer accepts only one of that row's three candidate codes, rejects duplicate CGI product IDs, and ignores unapproved rows. Multiple shop products may map to one ECOUNT code. It never deletes an earlier approval just because a later CSV row is blank.

## Administrator import and storage

After the code and migration are deployed by the release owner, post the reviewed CSV body as `text/csv` to:

```text
POST /api/admin/ecount/item-mappings/import
```

The route requires the existing administrator authorization, validates the approval column and candidate list, then upserts only approved pairs. It records the approver role, timestamp, and CSV SHA-256. A shop product has one approved code; multiple shop products may share an ECOUNT item code.

Migration `0008_ecount_item_mapping.sql` defines the table. It was added to the repository schema for local initialization; **no remote D1 migration was applied**. No ECOUNT export file has been received, no review CSV has been generated, and no product mapping has been approved in this change.
