// src/migrateCustomers.js
/**
 * Migra:
 *   - CUSTOMERTYPE (Firebird) → customertype (MySQL)
 *   - CUSTOMER    (Firebird) → customer    (MySQL)
 *
 * - Trabajo por lotes (FB_BATCH_SIZE / MYSQL_BATCH_SIZE desde .env)
 * - FULL REFRESH opcional (TRUNCATE detalle + maestro, respetando FK)
 * - No envía BLOBs (NOTES, WARNINGNOTES) → quedan NULL en MySQL
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateCustomers_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// ==========================
// Columnas CUSTOMERTYPE (MAYÚSCULAS)
// ==========================
const CUSTOMERTYPE_COLUMNS = [
  'CUSTOMERTYPE',
  'DESCRIPTION',
  'ARSUBLEDGERACCOUNTID',
  'ISCHARGEINTEREST',
  'ISISSUESTATEMENT',
  'ISBALANCEFORWARD',
  'TERMS',
  'CUSTOMERPRICELEVEL',
  'SHIPVIA',
  'SALESTAXCODE',
  'VATCODE',
  'ISTAXABLE',
  'CREDITLIMIT',
  'FIELD1',
  'FIELD2',
  'FIELD3',
  'ISORGANIZATION',
  'DEPOSITSUBLEDGERACCOUNTID',
  'EZLINKTYPE',
  'DEFAULTBILLTO',
  'ISACTIVE',
  'ISPOREQUIRED',
  'ISORDERCONTACTMANDATORY',
];

// ==========================
// Columnas CUSTOMER (sin BLOBs NOTES, WARNINGNOTES) (MAYÚSCULAS)
// ==========================
const CUSTOMER_COLUMNS = [
  'CUSTOMERID',
  'CUSTOMERTYPE',
  'NAME',
  'FIRSTNAME',
  'LASTNAME',
  'ADDRESS1',
  'ADDRESS2',
  'CITY',
  'STATE',
  'ZIP',
  'COUNTRY',
  'PHONE',
  'PHONEEXT',
  'ALTPHONE',
  'ALTPHONEEXT',
  'FAX',
  'FAXEXT',
  'EMAIL',
  'WEBPAGE',
  'ARSUBLEDGERACCOUNTID',
  'ISCHARGEINTEREST',
  'ISISSUESTATEMENT',
  'ISBALANCEFORWARD',
  'ARCONTACT',
  'SALESCONTACT',
  'SALESREP',
  'TERMS',
  'CREDITLIMIT',
  'SHIPVIA',
  'SALESTAXCODE',
  'SALESTAXLICENSE',
  'ISTAXABLE',
  'VATCODE',
  'VATLICENSE',
  'THEIRSUPPLIERID',
  // 'NOTES',  // BLOB → NO se envía
  'CUSTOMERPRICELEVEL',
  'CREDITCARDNUMBER',
  'EXPDATE',
  'FIELD1',
  'FIELD2',
  'FIELD3',
  'ENTRYDATE',
  'NAMESEARCH',
  'CITYSEARCH',
  'ISORGANIZATION',
  'ISPOREQUIRED',
  'ISWARNING',
  // 'WARNINGNOTES', // BLOB → NO se envía
  'DEPOSITSUBLEDGERACCOUNTID',
  'DRIVERSLICENSENUMBER',
  'DATEOFBIRTH',
  'MIDDLENAME',
  'COUNTY',
  'SSN',
  'LOGINPASSWORD',
  'ISEMAILSTATEMENT',
  'CELL',
  'CELLEXT',
  'ALLOWTEXTS',
  'DEFAULTBILLTO',
  'ISACTIVE',
  'ALLOWEMAIL',
  'LEGALNAME',
  'LASTCHANGEDATE',
  'ISORDERCONTACTMANDATORY',
];

// Normaliza valores Firebird → MySQL
function normalizeFbValue(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val;
  if (Buffer.isBuffer(val)) return val;

  const t = typeof val;
  if (t === 'string' || t === 'number' || t === 'boolean') return val;

  // Cualquier cosa rara (objetos, etc.) → NULL
  return null;
}

// Para debug en caso de error de INSERT
function logFirstWeirdValue(tableName, columns, valuesChunk) {
  for (let r = 0; r < valuesChunk.length; r++) {
    const row = valuesChunk[r];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (
        v !== null &&
        v !== undefined &&
        !(v instanceof Date) &&
        !Buffer.isBuffer(v) &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        const colName = columns[c];
        log.error(
          `🔎 Valor raro en tabla ${tableName}, fila ${r}, columna ${colName}: ` +
          `tipo=${typeof v}, constructor=${v && v.constructor && v.constructor.name}`
        );
        return;
      }
    }
  }
  log.error(`🔎 No se encontraron valores raros en chunk de tabla ${tableName}, pero MySQL falló igual.`);
}

async function migrateCustomers() {
  const startTime = Date.now();
  const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
  const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
  const fullRefresh = (process.env.FULL_REFRESH_CUSTOMER || 'true').toLowerCase() === 'true';

  log.info('🚀 Iniciando migración de CUSTOMERTYPE + CUSTOMER (Firebird) → MySQL...');
  log.info(`⚙️ FB_BATCH_SIZE = ${fbBatchSize}, MYSQL_BATCH_SIZE = ${mysqlBatchSize}`);
  log.info(`⚙️ FULL_REFRESH_CUSTOMER = ${fullRefresh}`);

  let fbDb = null;
  let mysqlConn = null;

  try {
    // Conexiones
    log.info('🔌 Conectando a Firebird (IDEAL)...');
    fbDb = await getFirebirdConnection();
    log.info('✅ Conectado a Firebird.');

    log.info('🔌 Conectando a MySQL...');
    mysqlConn = await getMySqlConnection();
    log.info('✅ Conectado a MySQL.');

    // FULL REFRESH: deshabilitar FK y truncar ambas tablas
    if (fullRefresh) {
      log.info('🧹 FULL REFRESH activado: deshabilitar FK y truncar customer/customertype...');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');
      await mysqlConn.query('TRUNCATE TABLE customer');
      await mysqlConn.query('TRUNCATE TABLE customertype');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
      log.info('✅ Tablas customer y customertype vaciadas.');
    }

    // =====================================================
    // 1) MIGRAR CUSTOMERTYPE (MAESTRO)
    // =====================================================
    const ctColumnList = CUSTOMERTYPE_COLUMNS.map(c => `\`${c}\``).join(', ');
    const ctUpdateAssignments = CUSTOMERTYPE_COLUMNS
      .filter(c => c !== 'CUSTOMERTYPE')
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const ctInsertSQL = `
      INSERT INTO customertype (${ctColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${ctUpdateAssignments}
    `;

    let offset = 0;
    let globalProcessedCT = 0;
    let fbBatchNumberCT = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberCT += 1;

      log.info(
        `📥 [CUSTOMERTYPE] Leyendo lote Firebird #${fbBatchNumberCT} (ROWS ${startRow} TO ${endRow}) de CUSTOMERTYPE...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM CUSTOMERTYPE
          ORDER BY CUSTOMERTYPE
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [CUSTOMERTYPE] No hay más registros en CUSTOMERTYPE. Fin de la lectura.');
        break;
      }

      log.info(`📊 [CUSTOMERTYPE] Lote Firebird #${fbBatchNumberCT}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          CUSTOMERTYPE_COLUMNS.map(col => normalizeFbValue(row[col]))
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [CUSTOMERTYPE] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberCT} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(ctInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [CUSTOMERTYPE] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('customertype', CUSTOMERTYPE_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedCT += values.length;

        log.info(
          `✅ [CUSTOMERTYPE] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total maestro CUSTOMERTYPE: ${globalProcessedCT}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [CUSTOMERTYPE] Terminado lote Firebird #${fbBatchNumberCT}. OFFSET ahora: ${offset}. Total maestro: ${globalProcessedCT}.`
      );
    }

    log.info('🎉 Migración de CUSTOMERTYPE completada.');
    log.info(`📌 Total registros CUSTOMERTYPE procesados: ${globalProcessedCT}`);

    // =====================================================
    // 2) MIGRAR CUSTOMER (DETALLE)
    // =====================================================
    const cColumnList = CUSTOMER_COLUMNS.map(c => `\`${c}\``).join(', ');
    const cUpdateAssignments = CUSTOMER_COLUMNS
      .filter(c => c !== 'CUSTOMERID')
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const cInsertSQL = `
      INSERT INTO customer (${cColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${cUpdateAssignments}
    `;

    offset = 0;
    let globalProcessedC = 0;
    let fbBatchNumberC = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberC += 1;

      log.info(
        `📥 [CUSTOMER] Leyendo lote Firebird #${fbBatchNumberC} (ROWS ${startRow} TO ${endRow}) de CUSTOMER...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM CUSTOMER
          ORDER BY CUSTOMERID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [CUSTOMER] No hay más registros en CUSTOMER. Fin de la lectura.');
        break;
      }

      log.info(`📊 [CUSTOMER] Lote Firebird #${fbBatchNumberC}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          CUSTOMER_COLUMNS.map(col => normalizeFbValue(row[col]))
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [CUSTOMER] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberC} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(cInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [CUSTOMER] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('customer', CUSTOMER_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedC += values.length;

        log.info(
          `✅ [CUSTOMER] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total CUSTOMER: ${globalProcessedC}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [CUSTOMER] Terminado lote Firebird #${fbBatchNumberC}. OFFSET ahora: ${offset}. Total CUSTOMER: ${globalProcessedC}.`
      );
    }

    log.info('🎉 Migración de CUSTOMER completada.');
    log.info(`📌 Total registros CUSTOMER procesados: ${globalProcessedC}`);
  } catch (err) {
    log.error('❌ Error general durante la migración de CUSTOMERTYPE/CUSTOMER', err);
  } finally {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info(`⏱ Duración total: ${elapsedSec} segundos`);

    if (fbDb) {
      try {
        fbDb.detach();
        log.info('🔚 Conexión Firebird cerrada.');
      } catch (e) {
        log.warn('⚠ Error al cerrar conexión Firebird', e);
      }
    }

    if (mysqlConn) {
      try {
        await mysqlConn.end();
        log.info('🔚 Conexión MySQL cerrada.');
      } catch (e) {
        log.warn('⚠ Error al cerrar conexión MySQL', e);
      }
    }
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  migrateCustomers();
}

module.exports = migrateCustomers;
