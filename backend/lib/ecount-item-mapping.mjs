const MAX_IMPORT_CHARS = 5_000_000;

const normalizeHeader = (value) => String(value || '')
  .normalize('NFKC')
  .toLocaleLowerCase('en-US')
  .replace(/[^\p{L}\p{N}]/gu, '');

const HEADER_ALIASES = {
  cgiProductId: new Set([
    'shopproductid', 'cgiproductid', 'productid',
    '\uC1FC\uD551\uBAB0\uC0C1\uD488id', '\uC1FC\uD551\uBAB0\uC0C1\uD488\uC544\uC774\uB514', '\uC0C1\uD488id',
  ].map(normalizeHeader)),
  approvedCode: new Set([
    'approvedecountcode', 'approval', '\uC2B9\uC778', '\uC2B9\uC778\uCF54\uB4DC',
  ].map(normalizeHeader)),
  candidateCodes: [1, 2, 3].map((number) => new Set([
    `candidate${number}code`, `option${number}code`,
    `\uD6C4\uBCF4${number}\uCF54\uB4DC`, `\uD6C4\uBCF4${number}\uD488\uBAA9\uCF54\uB4DC`,
  ].map(normalizeHeader))),
};

function parseCsvRows(source) {
  const text = String(source || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field !== '') throw new Error('invalid_csv_quote');
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = '';
    } else if (char === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (char !== '\r') field += char;
  }
  if (quoted) throw new Error('unterminated_csv_quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function headerIndexes(headers) {
  const normalized = headers.map(normalizeHeader);
  const find = (aliases) => normalized.findIndex((header) => aliases.has(header));
  const cgiProductId = find(HEADER_ALIASES.cgiProductId);
  const approvedCode = find(HEADER_ALIASES.approvedCode);
  const candidateCodes = HEADER_ALIASES.candidateCodes.map(find);
  if (cgiProductId < 0 || approvedCode < 0 || candidateCodes.some((index) => index < 0)) {
    throw new Error('required_csv_columns_missing');
  }
  if (new Set([cgiProductId, approvedCode, ...candidateCodes]).size !== 5) {
    throw new Error('duplicate_csv_columns');
  }
  return { cgiProductId, approvedCode, candidateCodes };
}

/** Parse the review CSV and return explicit approvals only. */
export function parseApprovedEcountMappingCsv(source) {
  const text = String(source || '');
  if (text.length > MAX_IMPORT_CHARS) throw new Error('csv_too_large');
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('csv_has_no_data_rows');
  const indexes = headerIndexes(rows[0]);
  const approvals = [];
  const cgiIds = new Set();
  let unapprovedRows = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.some((value) => String(value || '').trim())) continue;
    const approvedCode = String(row[indexes.approvedCode] || '').trim();
    if (!approvedCode) { unapprovedRows += 1; continue; }
    const cgiProductId = String(row[indexes.cgiProductId] || '').trim();
    const candidateCodes = indexes.candidateCodes.map((column) => String(row[column] || '').trim()).filter(Boolean);
    if (!cgiProductId || cgiProductId.length > 128 || /[\u0000-\u001F\u007F]/.test(cgiProductId)) {
      throw new Error(`invalid_cgi_product_id_at_row_${index + 1}`);
    }
    if (approvedCode.length > 20 || /[\u0000-\u001F\u007F]/.test(approvedCode)) {
      throw new Error(`invalid_ecount_code_at_row_${index + 1}`);
    }
    if (!candidateCodes.includes(approvedCode)) throw new Error(`approval_not_in_candidate_list_at_row_${index + 1}`);
    if (cgiIds.has(cgiProductId)) throw new Error(`duplicate_cgi_product_id_at_row_${index + 1}`);
    cgiIds.add(cgiProductId);
    approvals.push({ cgiProductId, ecountProdCd: approvedCode, csvRow: index + 1 });
  }
  return { approvals, unapprovedRows };
}

export async function loadApprovedEcountItemMap(db, items = []) {
  const cgiIds = [...new Set((items || []).map((item) => String(item?.product_id || '').trim()).filter(Boolean))];
  if (!cgiIds.length) return {};
  const mapping = Object.create(null);
  for (let offset = 0; offset < cgiIds.length; offset += 100) {
    const chunk = cgiIds.slice(offset, offset + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db.prepare(
      `SELECT cgi_product_id, ecount_prod_cd FROM ecount_item_mapping WHERE cgi_product_id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const row of results || []) mapping[row.cgi_product_id] = row.ecount_prod_cd;
  }
  return mapping;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
