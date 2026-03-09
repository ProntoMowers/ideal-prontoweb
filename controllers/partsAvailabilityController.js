// controllers/partsAvailabilityController.js
const { processProductsBatch } = require('../services/partsAvailabilityService');
const logger = require('../helpers/logger')('partsAvailabilityController.log');

/**
 * Controller for POST /v1/parts/availability/resolve
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function resolvePartsAvailability(req, res) {
  try {
    const { storeId, locationId, products } = req.body;

    // Validate required fields
    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: 'storeId is required'
      });
    }

    if (!locationId) {
      return res.status(400).json({
        success: false,
        message: 'locationId is required'
      });
    }

    if (!products || !Array.isArray(products)) {
      return res.status(400).json({
        success: false,
        message: 'products must be a non-empty array'
      });
    }

    if (products.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'products array cannot be empty'
      });
    }

    // Validate each product
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      
      if (!product.brand) {
        return res.status(400).json({
          success: false,
          message: `products[${i}]: brand is required`
        });
      }

      if (!product.sku && !product.mpn) {
        return res.status(400).json({
          success: false,
          message: `products[${i}]: either sku or mpn is required`
        });
      }
    }

    logger.info(`Processing ${products.length} products for storeId=${storeId}, locationId=${locationId}`);

    // Process products
    const results = await processProductsBatch(products, storeId, locationId);

    // Return response
    return res.status(200).json({
      success: true,
      storeId,
      locationId,
      total: results.length,
      results
    });

  } catch (error) {
    logger.error('Error in resolvePartsAvailability controller', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

module.exports = {
  resolvePartsAvailability
};
