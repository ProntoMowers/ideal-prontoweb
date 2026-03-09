// services/partsAvailabilityService.js
const { getPostgresPool, getMySqlConnection } = require('../providers/dbConnections');
const logger = require('../helpers/logger')('partsAvailabilityService.log');

/**
 * Resolve a single product to get mfridIdeal and partNumberIdeal
 * @param {Object} product - Product object with brand and sku/mpn
 * @param {number} storeId - Store ID
 * @param {Object} mysqlConn - MySQL connection
 * @returns {Object} Result with match info or null
 */
async function resolveProduct(product, storeId, mysqlConn) {
  const { brand, sku, mpn } = product;
  const searchValue = sku || mpn;
  const isSkuSearch = !!sku;

  try {
    // Step 1: Try PostgreSQL product_match first
    const pgPool = getPostgresPool();
    const pgResult = await pgPool.query(
      'SELECT mfr_ideal, partnumber_ideal FROM public.product_match WHERE brand = $1 AND sku = $2 LIMIT 1',
      [brand, searchValue]
    );

    if (pgResult.rows.length > 0) {
      const row = pgResult.rows[0];
      return {
        strategy: 'product_match',
        mfridIdeal: row.mfr_ideal,
        partNumberIdeal: row.partnumber_ideal
      };
    }

    // Step 2: Fall back to brandsandstores + brands
    const [brandsRows] = await mysqlConn.query(
      `SELECT mfrid, brandprefijo 
       FROM brandsandstores 
       WHERE storeid = ? AND brandbc = ?
       LIMIT 1`,
      [storeId, brand]
    );

    if (brandsRows.length === 0) {
      logger.warn(`Brand not found in brandsandstores for storeId=${storeId}, brand=${brand}`);
      return null;
    }

    const { mfrid, brandprefijo } = brandsRows[0];
    let partNumber = searchValue;

    // Step 3: Remove brand prefix only if searching by SKU
    if (isSkuSearch && brandprefijo) {
      const prefix = brandprefijo.trim();
      if (prefix && partNumber.toUpperCase().startsWith(prefix.toUpperCase())) {
        partNumber = partNumber.substring(prefix.length).trim();
      }
    }

    // Step 4: Apply suffix from brands table
    const [brandsSuffix] = await mysqlConn.query(
      'SELECT sufsku FROM brands WHERE mfrid = ? LIMIT 1',
      [mfrid]
    );

    if (brandsSuffix.length > 0 && brandsSuffix[0].sufsku) {
      const suffix = brandsSuffix[0].sufsku.trim();
      if (suffix && !partNumber.toUpperCase().endsWith(suffix.toUpperCase())) {
        partNumber = partNumber + suffix;
      }
    }

    return {
      strategy: 'brandsandstores',
      mfridIdeal: mfrid,
      partNumberIdeal: partNumber
    };

  } catch (error) {
    logger.error(`Error resolving product: brand=${brand}, sku=${sku}, mpn=${mpn}`, error);
    throw error;
  }
}

/**
 * Get inventory availability from productlocation
 * @param {string} mfrid - Manufacturer ID
 * @param {string} partNumber - Part number
 * @param {number} locationId - Location ID
 * @param {Object} mysqlConn - MySQL connection
 * @returns {number} Available quantity
 */
async function getInventory(mfrid, partNumber, locationId, mysqlConn) {
  try {
    const [rows] = await mysqlConn.query(
      `SELECT COALESCE(SUM(ONHANDAVAILABLEQUANTITY), 0) AS onHandAvailability
       FROM productlocation
       WHERE MFRID = ? AND PARTNUMBER = ? AND LOCATIONID = ?`,
      [mfrid, partNumber, locationId]
    );

    return rows[0]?.onHandAvailability || 0;
  } catch (error) {
    logger.error(`Error getting inventory for ${mfrid}/${partNumber} at location ${locationId}`, error);
    throw error;
  }
}

/**
 * Get stock levels from productstock
 * @param {string} mfrid - Manufacturer ID
 * @param {string} partNumber - Part number
 * @param {number} locationId - Location ID
 * @param {Object} mysqlConn - MySQL connection
 * @returns {Object} Stock levels object
 */
async function getStockLevels(mfrid, partNumber, locationId, mysqlConn) {
  try {
    const [rows] = await mysqlConn.query(
      `SELECT
        COALESCE(STOCKLEVEL1, 0) AS stockLevel1,
        COALESCE(STOCKLEVEL2, 0) AS stockLevel2,
        COALESCE(STOCKLEVEL3, 0) AS stockLevel3,
        COALESCE(STOCKLEVEL4, 0) AS stockLevel4
       FROM productstock
       WHERE MFRID = ? AND PARTNUMBER = ? AND LOCATIONID = ?
       LIMIT 1`,
      [mfrid, partNumber, locationId]
    );

    if (rows.length === 0) {
      return {
        stockLevel1: 0,
        stockLevel2: 0,
        stockLevel3: 0,
        stockLevel4: 0
      };
    }

    return {
      stockLevel1: rows[0].stockLevel1,
      stockLevel2: rows[0].stockLevel2,
      stockLevel3: rows[0].stockLevel3,
      stockLevel4: rows[0].stockLevel4
    };
  } catch (error) {
    logger.error(`Error getting stock levels for ${mfrid}/${partNumber} at location ${locationId}`, error);
    throw error;
  }
}

/**
 * Process a batch of products and resolve availability
 * @param {Array} products - Array of product objects
 * @param {number} storeId - Store ID
 * @param {number} locationId - Location ID
 * @returns {Array} Array of results
 */
async function processProductsBatch(products, storeId, locationId) {
  const results = [];
  let mysqlConn = null;

  try {
    mysqlConn = await getMySqlConnection();

    for (const product of products) {
      const result = {
        input: {
          brand: product.brand,
          sku: product.sku || null,
          mpn: product.mpn || null
        },
        match: null,
        inventory: null,
        stockLevels: null,
        success: false,
        error: null
      };

      try {
        // Validate product input
        if (!product.brand) {
          throw new Error('Brand is required');
        }
        if (!product.sku && !product.mpn) {
          throw new Error('Either sku or mpn is required');
        }

        // Resolve product
        const matchResult = await resolveProduct(product, storeId, mysqlConn);
        
        if (!matchResult) {
          throw new Error('Product not found or brand not configured');
        }

        result.match = matchResult;

        // Get inventory
        const onHandAvailability = await getInventory(
          matchResult.mfridIdeal,
          matchResult.partNumberIdeal,
          locationId,
          mysqlConn
        );
        result.inventory = { onHandAvailability };

        // Get stock levels
        result.stockLevels = await getStockLevels(
          matchResult.mfridIdeal,
          matchResult.partNumberIdeal,
          locationId,
          mysqlConn
        );

        result.success = true;
      } catch (error) {
        result.error = error.message;
        logger.error(`Error processing product: ${JSON.stringify(product)}`, error);
      }

      results.push(result);
    }

    return results;

  } finally {
    if (mysqlConn) {
      await mysqlConn.end();
    }
  }
}

module.exports = {
  processProductsBatch,
  resolveProduct,
  getInventory,
  getStockLevels
};
