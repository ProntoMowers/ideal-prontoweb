const { reverseLookupParts } = require('../services/partsReverseLookupService');
const logger = require('../helpers/logger')('partsReverseLookupController.log');

/**
 * POST /v1/parts/reverse/resolve
 * Body:
 * {
 *   "parts": [{ "mfrid": "BRS", "partnumber": "492932S" }],
 *   "clearence": "y",      // opcional
 *   "newproduct": "n"      // opcional
 * }
 */
async function resolveReverseParts(req, res) {
  try {
    const { parts, clearence, newproduct } = req.body || {};

    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'parts must be a non-empty array',
      });
    }

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] || {};

      if (!part.mfrid || String(part.mfrid).trim() === '') {
        return res.status(400).json({
          success: false,
          message: `parts[${i}]: mfrid is required`,
        });
      }

      if (!part.partnumber || String(part.partnumber).trim() === '') {
        return res.status(400).json({
          success: false,
          message: `parts[${i}]: partnumber is required`,
        });
      }
    }

    logger.info(`Reverse lookup request received: parts=${parts.length}`);

    const payload = await reverseLookupParts(parts, { clearence, newproduct });

    return res.status(200).json({
      success: true,
      ...payload,
    });
  } catch (error) {
    logger.error('Error in resolveReverseParts controller', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
}

module.exports = {
  resolveReverseParts,
};
