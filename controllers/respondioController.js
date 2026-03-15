const logger = require('../helpers/logger')('respondioController.log');
const { upsertRespondioContact, upsertRespondioContactBulk } = require('../services/respondioContactService');

/**
 * POST /v1/respondio/contact/upsert
 * Body:
 * {
 *   "name": "ACME Corp",                 // NAME de customer
 *   "firstname": "",                     // FIRSTNAME de customer
 *   "lastname": "",                      // LASTNAME de customer
 *   "cell": "+13055551234",              // CELL de customer (opcional)
 *   "phone": "+13055550000",             // PHONE de customer (opcional)
 *   "email": "contact@acme.com",         // EMAIL de customer
 *   "language": "es",                    // FAX mapeado: es|en|''
 *   "country": "United States",          // COUNTRY de customer (opcional)
 *   "countryCode": "US",                 // ISO 3166-1 alpha-2 (opcional, si no viene se resuelve por countries)
 *   "isCompany": true,
 *   "tag": "VIP"
 * }
 */
async function upsertContact(req, res) {
  try {
    const {
      name,
      firstName,
      firstname,
      lastName,
      lastname,
      cell,
      email,
      phone,
      language,
      country,
      countryCode,
      isCompany,
      tag
    } = req.body || {};

    const result = await upsertRespondioContact({
      name,
      firstName,
      firstname,
      lastName,
      lastname,
      cell,
      email,
      phone,
      language,
      country,
      countryCode,
      isCompany,
      tag
    });

    return res.status(200).json({
      success: true,
      message: result.action === 'created' ? 'Contacto creado en Respond.io' : 'Contacto actualizado en Respond.io',
      data: result
    });
  } catch (error) {
    logger.error('Error en upsert de contacto Respond.io', error);

    const statusCode = error.statusCode || error.response?.status || 500;
    const apiError = error.response?.data;

    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Error procesando contacto en Respond.io',
      details: apiError || null
    });
  }
}

/**
 * POST /v1/respondio/contact/upsert/bulk
 * Body:
 * {
 *   "contacts": [
 *     { "name": "...", "email": "...", "phone": "...", "tag": "VIP" },
 *     ...
 *   ],
 *   "tag": "VIP"   // tag por defecto si el contacto no trae el suyo
 * }
 *
 * Respuesta:
 * {
 *   "success": true,
 *   "data": { "total": 10, "created": 7, "updated": 2, "errors": [...] }
 * }
 */
async function upsertBulkContacts(req, res) {
  try {
    const { contacts, tag: defaultTag } = req.body || {};

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'El campo contacts debe ser un array no vacío'
      });
    }

    const summary = await upsertRespondioContactBulk({ contacts, defaultTag });

    return res.status(200).json({
      success: true,
      message: `Proceso completado: ${summary.created} creados, ${summary.updated} actualizados, ${summary.errors.length} errores`,
      data: summary
    });
  } catch (error) {
    logger.error('Error en bulk upsert de contactos Respond.io', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Error procesando bulk de contactos en Respond.io'
    });
  }
}

module.exports = {
  upsertContact,
  upsertBulkContacts
};
