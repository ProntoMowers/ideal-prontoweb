// controllers/returnsController.js
const returnsService = require('../services/returnsService');
const logger = require('../helpers/logger')('returnsController.log');

const toYN = (val) => (val === '1' || val === 1 || val === true || val === 'on' || val === 'y') ? 'YES' : 'NO';

/**
 * POST /v1/returns/submit
 * Handle return submission with images
 */
async function submitReturn(req, res) {
  try {
    logger.info(`Received return submission for order: ${req.body.order_number}`);
    
    // Validate required fields
    const { order_number, part_number, customer_email, customer_name, return_reason } = req.body;
    
    if (!order_number || !part_number || !customer_email || !customer_name || !return_reason) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Prepare return data
    const returnData = {
      order_number,
      part_number,
      customer_email,
      customer_name,
      return_reason,
      is_last_30_days: toYN(req.body.is_last_30_days) === 'YES' ? 'y' : 'n',
      is_original_pkg: toYN(req.body.is_original_pkg) === 'YES' ? 'y' : 'n',
      is_electronic: toYN(req.body.is_electronic) === 'YES' ? 'y' : 'n'
    };

    // Process return submission
    const result = await returnsService.processReturn(returnData, req.files || [], req.body);
    
    logger.info(`Return processed successfully: ID ${result.id}, Ticket: ${result.zohoTicket}`);
    
    res.status(200).json({
      success: true,
      id: result.id,
      zohoTicket: result.zohoTicket
    });

  } catch (error) {
    logger.error('Error processing return submission', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message || 'Internal server error processing return'
      });
    }
  }
}

module.exports = {
  submitReturn
};
