// middleware/apiKeyAuth.js
require('dotenv').config();

/**
 * Middleware to validate API Key from x-api-key header
 * @param {string} envKeyName - Name of the environment variable containing the expected API key
 * @returns {Function} Express middleware function
 */
function apiKeyAuth(envKeyName = 'PARTS_AVAILABILITY_API_KEY') {
  return (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env[envKeyName];

    if (!expectedKey) {
      console.error(`API Key validation error: Environment variable ${envKeyName} is not set`);
      return res.status(500).json({
        success: false,
        message: 'Internal server configuration error'
      });
    }

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    if (apiKey !== expectedKey) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    next();
  };
}

module.exports = apiKeyAuth;
