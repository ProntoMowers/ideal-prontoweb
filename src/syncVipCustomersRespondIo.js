// src/syncVipCustomersRespondIo.js
/**
 * SINCRONIZACIÓN DE CLIENTES VIP CON RESPOND.IO
 * 
 * Identifica clientes VIP basados en criterios configurables:
 * - Número mínimo de ventas en el último año
 * - Monto mínimo facturado en el último año
 * 
 * Los crea o actualiza en Respond.io con tags apropiados.
 */

require('dotenv').config();
const axios = require('axios');
const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `syncVipCustomersRespondIo_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// Configuración desde .env
const RESPONDIO_ACCESS_TOKEN = process.env.RESPONDIO_ACCESS_TOKEN;
const RESPONDIO_API_URL = process.env.RESPONDIO_API_URL || 'https://api.respond.io/v2';

// Límites y criterios VIP configurables
const MAX_CUSTOMERS_TO_IMPORT = Number(process.env.VIP_MAX_CUSTOMERS || 100);
const MIN_SALES_COUNT = Number(process.env.VIP_MIN_SALES_COUNT || 2);
const MIN_SALES_AMOUNT = Number(process.env.VIP_MIN_SALES_AMOUNT || 1000);
const VIP_TAG = process.env.VIP_TAG || 'VIP';
const LOOKBACK_DAYS = Number(process.env.VIP_LOOKBACK_DAYS || 365);

/**
 * Consulta clientes VIP desde MySQL
 */
async function getVipCustomers(mysqlConn) {
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - LOOKBACK_DAYS);
  const lookbackDateStr = lookbackDate.toISOString().slice(0, 10);

  log('INFO', `Buscando clientes VIP con criterios:`);
  log('INFO', `  - Mínimo ${MIN_SALES_COUNT} ventas en los últimos ${LOOKBACK_DAYS} días`);
  log('INFO', `  - Monto mínimo facturado: $${MIN_SALES_AMOUNT}`);
  log('INFO', `  - Fecha desde: ${lookbackDateStr}`);

  const query = `
    SELECT 
      c.CUSTOMERID,
      c.NAME,
      c.FIRSTNAME,
      c.LASTNAME,
      c.EMAIL,
      c.PHONE,
      c.CELL,
      c.ADDRESS1,
      c.ADDRESS2,
      c.CITY,
      c.STATE,
      c.ZIP,
      c.COUNTRY,
      COUNT(si.ARTRANSID) as sales_count,
      SUM(si.ARAMOUNT) as total_sales_amount
    FROM customer c
    INNER JOIN salesinvoice si ON c.CUSTOMERID = si.CUSTOMERID
    WHERE si.TRANSDATE >= ?
      AND si.ARTYPE = 'IN'
      AND c.EMAIL IS NOT NULL
      AND c.EMAIL != ''
      AND c.ISACTIVE = 'T'
    GROUP BY 
      c.CUSTOMERID,
      c.NAME,
      c.FIRSTNAME,
      c.LASTNAME,
      c.EMAIL,
      c.PHONE,
      c.CELL,
      c.ADDRESS1,
      c.ADDRESS2,
      c.CITY,
      c.STATE,
      c.ZIP,
      c.COUNTRY
    HAVING 
      COUNT(si.ARTRANSID) >= ?
      AND SUM(si.ARAMOUNT) >= ?
    ORDER BY total_sales_amount DESC
    LIMIT ?
  `;

  const [rows] = await mysqlConn.execute(query, [
    lookbackDateStr,
    MIN_SALES_COUNT,
    MIN_SALES_AMOUNT,
    MAX_CUSTOMERS_TO_IMPORT
  ]);

  return rows;
}

/**
 * Normaliza el teléfono para WhatsApp (formato E.164)
 */
function normalizePhone(phone, cell, countryCode = '1') {
  let phoneNumber = cell || phone || '';
  
  // Limpiar caracteres no numéricos
  phoneNumber = phoneNumber.replace(/\D/g, '');
  
  // Si está vacío, retornar null
  if (!phoneNumber) return null;
  
  // Si no comienza con código de país, agregarlo
  if (!phoneNumber.startsWith(countryCode)) {
    phoneNumber = countryCode + phoneNumber;
  }
  
  // Validar longitud mínima (al menos 10 dígitos después del código)
  if (phoneNumber.length < 11) return null;
  
  return '+' + phoneNumber;
}

/**
 * Busca un contacto existente en Respond.io por email o teléfono
 * @param {string} email - Email del cliente
 * @param {string} phone - Teléfono del cliente (formato normalizado)
 * @returns {object|null} Contacto encontrado o null
 */
async function findContact(email, phone) {
  try {
    // Intentar buscar por email primero
    if (email && email.trim()) {
      try {
        const identifier = `email:${email}`;
        const response = await axios.get(`${RESPONDIO_API_URL}/contact/${identifier}`, {
          headers: {
            'Authorization': `Bearer ${RESPONDIO_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        return response.data;
      } catch (error) {
        if (error.response && error.response.status === 404) {
          // No encontrado por email, continuar
        } else {
          throw error;
        }
      }
    }

    // Si no encontró por email, intentar por teléfono
    if (phone && phone.trim()) {
      try {
        const identifier = `phone:${phone}`;
        const response = await axios.get(`${RESPONDIO_API_URL}/contact/${identifier}`, {
          headers: {
            'Authorization': `Bearer ${RESPONDIO_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        return response.data;
      } catch (error) {
        if (error.response && error.response.status === 404) {
          return null; // No encontrado ni por email ni por teléfono
        }
        throw error;
      }
    }

    return null; // No hay email ni teléfono para buscar
  } catch (error) {
    log('ERROR', `Error buscando contacto (email: ${email}, phone: ${phone}): ${error.message}`);
    throw error;
  }
}

/**
 * Crea un nuevo contacto en Respond.io
 */
async function createContact(customer) {
  const phone = normalizePhone(customer.PHONE, customer.CELL);
  
  const contactData = {
    firstName: customer.FIRSTNAME || customer.NAME.split(' ')[0] || customer.NAME,
    lastName: customer.LASTNAME || customer.NAME.split(' ').slice(1).join(' ') || '',
    email: customer.EMAIL
  };

  // Agregar teléfono solo si es válido
  if (phone) {
    contactData.phone = phone;
  }

  // Usar email como identifier
  const identifier = `email:${customer.EMAIL}`;
  const response = await axios.post(`${RESPONDIO_API_URL}/contact/${identifier}`, contactData, {
    headers: {
      'Authorization': `Bearer ${RESPONDIO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  // Retornar el contacto creado
  return response.data;
}

/**
 * Actualiza un contacto existente en Respond.io (principalmente tags)
 * @param {number} contactId - ID del contacto en Respond.io
 * @param {object} customer - Datos del cliente
 * @param {array} existingTags - Tags existentes del contacto
 */
async function updateContact(contactId, customer, existingTags = []) {
  // Asegurar que el tag VIP esté presente
  const tagsSet = new Set(existingTags || []);
  tagsSet.add(VIP_TAG);

  const updateData = {
    tags: Array.from(tagsSet)
  };

  const response = await axios.put(
    `${RESPONDIO_API_URL}/contact/${contactId}`,
    updateData,
    {
      headers: {
        'Authorization': `Bearer ${RESPONDIO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

/**
 * Procesa un cliente: crea o actualiza en Respond.io
 */
async function processCustomer(customer, index, total) {
  try {
    log('INFO', `[${index + 1}/${total}] Procesando: ${customer.CUSTOMERID} - ${customer.NAME}`);
    
    const phone = normalizePhone(customer.PHONE, customer.CELL);
    
    // Buscar si ya existe (por email o teléfono)
    const existingContact = await findContact(customer.EMAIL, phone);

    if (existingContact) {
      log('INFO', `  ✓ Contacto existente encontrado (ID: ${existingContact.id}). Actualizando tags...`);
      await updateContact(existingContact.id, customer, existingContact.tags || []);
      log('INFO', `  ✓ Contacto actualizado: ${customer.EMAIL}`);
      return { status: 'updated', customerId: customer.CUSTOMERID };
    } else {
      log('INFO', `  → Creando nuevo contacto...`);
      const newContact = await createContact(customer);
      log('INFO', `  ✓ Contacto creado: ${customer.EMAIL} (ID: ${newContact.id})`);
      return { status: 'created', customerId: customer.CUSTOMERID };
    }
  } catch (error) {
    log('ERROR', `  ✗ Error procesando ${customer.CUSTOMERID}: ${error.message}`);
    if (error.response && error.response.data) {
      log('ERROR', `    API Response: ${JSON.stringify(error.response.data)}`);
    }
    return { status: 'error', customerId: customer.CUSTOMERID, error: error.message };
  }
}

/**
 * Función principal
 */
async function main() {
  const startTime = Date.now();
  log('INFO', '='.repeat(70));
  log('INFO', 'INICIO: Sincronización de Clientes VIP con Respond.io');
  log('INFO', '='.repeat(70));

  // Validar configuración
  if (!RESPONDIO_ACCESS_TOKEN) {
    log('ERROR', 'RESPONDIO_ACCESS_TOKEN no configurado en .env');
    process.exit(1);
  }

  let mysqlConn = null;
  
  try {
    // Conectar a MySQL
    log('INFO', 'Conectando a MySQL...');
    mysqlConn = await getMySqlConnection();
    log('INFO', '✓ Conexión MySQL establecida');

    // Obtener clientes VIP
    log('INFO', 'Consultando clientes VIP...');
    const vipCustomers = await getVipCustomers(mysqlConn);
    log('INFO', `✓ Encontrados ${vipCustomers.length} clientes VIP`);

    if (vipCustomers.length === 0) {
      log('WARN', 'No se encontraron clientes VIP con los criterios especificados');
      return;
    }

    // Mostrar resumen de los top 5
    log('INFO', '');
    log('INFO', 'Top 5 Clientes VIP:');
    vipCustomers.slice(0, 5).forEach((c, i) => {
      log('INFO', `  ${i + 1}. ${c.CUSTOMERID} - ${c.NAME} | Ventas: ${c.sales_count} | Total: $${c.total_sales_amount.toFixed(2)}`);
    });
    log('INFO', '');

    // Procesar clientes con delay para no saturar la API
    log('INFO', 'Iniciando sincronización con Respond.io...');
    const results = {
      created: 0,
      updated: 0,
      errors: 0
    };

    for (let i = 0; i < vipCustomers.length; i++) {
      const result = await processCustomer(vipCustomers[i], i, vipCustomers.length);
      
      if (result.status === 'created') results.created++;
      else if (result.status === 'updated') results.updated++;
      else if (result.status === 'error') results.errors++;

      // Delay de 500ms entre requests para no saturar la API
      if (i < vipCustomers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Resumen final
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log('INFO', '');
    log('INFO', '='.repeat(70));
    log('INFO', 'RESUMEN DE SINCRONIZACIÓN:');
    log('INFO', `  - Clientes procesados: ${vipCustomers.length}`);
    log('INFO', `  - Contactos creados: ${results.created}`);
    log('INFO', `  - Contactos actualizados: ${results.updated}`);
    log('INFO', `  - Errores: ${results.errors}`);
    log('INFO', `  - Tiempo total: ${duration}s`);
    log('INFO', '='.repeat(70));
    log('INFO', 'FIN: Sincronización completada exitosamente');
    log('INFO', '='.repeat(70));

  } catch (error) {
    log('ERROR', `Error fatal: ${error.message}`);
    log('ERROR', error.stack);
    throw error;
  } finally {
    if (mysqlConn) {
      await mysqlConn.end();
      log('INFO', 'Conexión MySQL cerrada');
    }
  }
}

// Ejecutar
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Error fatal:', error);
      process.exit(1);
    });
}

module.exports = { main };
