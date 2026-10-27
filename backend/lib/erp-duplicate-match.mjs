/**
 * ERP duplicate matching: CGI products vs existing ERP items.
 *
 * Classifies each CGI product against the ERP master into one of:
 *   EXACT_MATCH     - same item confirmed (manufacturer part number or barcode match)
 *   PROBABLE_MATCH  - high likelihood of same item (manufacturer + model match)
 *   NEW_PRODUCT     - no matching ERP item found (new item candidate)
 *   CONFLICT        - conflicting information (same code, different details)
 *
 * Matching priority:
 *   1. Manufacturer part number (exact)
 *   2. Barcode (exact)
 *   3. Manufacturer + model (exact)
 *   4. Normalized product name (fuzzy)
 */

export const MATCH_CLASSES = {
  EXACT_MATCH: 'EXACT_MATCH',
  PROBABLE_MATCH: 'PROBABLE_MATCH',
  NEW_PRODUCT: 'NEW_PRODUCT',
  CONFLICT: 'CONFLICT',
};

/**
 * Normalize a string for comparison: lowercase, trim, collapse whitespace,
 * remove special characters.
 */
export function normalizeString(value) {
  if (value == null) return '';
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s가-힣]/g, '');
}

/**
 * Normalize a model number for comparison.
 */
export function normalizeModel(value) {
  if (value == null) return '';
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9가-힣]/g, '');
}

/**
 * Normalize a barcode for comparison.
 */
export function normalizeBarcode(value) {
  if (value == null) return '';
  return String(value).trim().replace(/\s+/g, '');
}

/**
 * Compute a match score between a CGI product and an ERP item.
 * Returns a number 0-100.
 */
export function matchScore(cgiProduct, erpItem) {
  let score = 0;
  const cgiPartNo = normalizeModel(cgiProduct.model || cgiProduct.modelNumber || '');
  const erpPartNo = normalizeModel(erpItem.model || erpItem.modelNumber || erpItem.PROD_DES || '');
  const cgiBarcode = normalizeBarcode(cgiProduct.barCode || cgiProduct.barcode || '');
  const erpBarcode = normalizeBarcode(erpItem.barCode || erpItem.BAR_CODE || erpItem.barcode || '');
  const cgiManufacturer = normalizeString(cgiProduct.manufacturer || cgiProduct.brand || '');
  const erpManufacturer = normalizeString(erpItem.manufacturer || erpItem.brand || erpItem.PROD_DES || '');
  const cgiName = normalizeString(cgiProduct.prodDes || cgiProduct.name || '');
  const erpName = normalizeString(erpItem.prodDes || erpItem.name || erpItem.PROD_DES || '');

  // Priority 1: manufacturer part number exact match
  if (cgiPartNo && erpPartNo && cgiPartNo === erpPartNo) score += 40;
  // Priority 2: barcode exact match
  if (cgiBarcode && erpBarcode && cgiBarcode === erpBarcode) score += 30;
  // Priority 3: manufacturer + model match
  if (cgiManufacturer && erpManufacturer && cgiManufacturer === erpManufacturer && cgiPartNo && erpPartNo && cgiPartNo === erpPartNo) score += 20;
  // Priority 4: normalized name similarity
  if (cgiName && erpName) {
    if (cgiName === erpName) score += 10;
    else if (cgiName.includes(erpName) || erpName.includes(cgiName)) score += 5;
  }

  return Math.min(100, score);
}

/**
 * Classify a match between a CGI product and an ERP item.
 * @param {Object} cgiProduct
 * @param {Object|null} erpItem - null if no ERP item found
 * @param {number} score - match score 0-100
 * @returns {string} one of MATCH_CLASSES
 */
export function classifyMatch(cgiProduct, erpItem, score) {
  if (!erpItem) return MATCH_CLASSES.NEW_PRODUCT;
  // Check for conflicts: same code but different details
  const cgiCode = cgiProduct.erpProdCd || cgiProduct.erpProdCdProposed || '';
  const erpCode = erpItem.PROD_CD || erpItem.prodCd || erpItem.erpProdCd || '';
  if (cgiCode && erpCode && cgiCode === erpCode) {
    // Same code - check if details match
    const cgiName = normalizeString(cgiProduct.prodDes || '');
    const erpName = normalizeString(erpItem.prodDes || erpItem.PROD_DES || '');
    if (cgiName && erpName && cgiName !== erpName) {
      return MATCH_CLASSES.CONFLICT;
    }
  }
  // Score-based classification
  if (score >= 70) return MATCH_CLASSES.EXACT_MATCH;
  if (score >= 40) return MATCH_CLASSES.PROBABLE_MATCH;
  return MATCH_CLASSES.NEW_PRODUCT;
}

/**
 * Match CGI products against ERP items.
 * @param {Array} cgiProducts - array of CGI product records
 * @param {Array} erpItems - array of ERP item records
 * @returns {Array} array of match results
 */
export function matchProducts(cgiProducts, erpItems) {
  const erpList = erpItems || [];
  const results = [];
  const usedErpCodes = new Set();

  for (const cgi of cgiProducts) {
    let bestMatch = null;
    let bestScore = 0;

    for (const erp of erpList) {
      if (usedErpCodes.has(erp.PROD_CD || erp.prodCd || erp.erpProdCd)) continue;
      const score = matchScore(cgi, erp);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = erp;
      }
    }

    const matchClass = classifyMatch(cgi, bestMatch, bestScore);
    if (bestMatch && matchClass !== MATCH_CLASSES.NEW_PRODUCT) {
      usedErpCodes.add(bestMatch.PROD_CD || bestMatch.prodCd || bestMatch.erpProdCd);
    }

    results.push({
      cgiId: cgi.cgiId || cgi.id || cgi.sourceId,
      cgiName: cgi.prodDes || cgi.name || '',
      erpItem: bestMatch,
      erpCode: bestMatch ? (bestMatch.PROD_CD || bestMatch.prodCd || bestMatch.erpProdCd || '') : null,
      score: bestScore,
      matchClass,
    });
  }

  return results;
}

/**
 * Summarize match results.
 */
export function summarizeMatches(results) {
  const summary = {
    total: results.length,
    EXACT_MATCH: 0,
    PROBABLE_MATCH: 0,
    NEW_PRODUCT: 0,
    CONFLICT: 0,
  };
  for (const r of results) {
    if (summary[r.matchClass] !== undefined) summary[r.matchClass]++;
  }
  return summary;
}
