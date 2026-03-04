// src/migrateSalesInvoices.js
/**
 * Migra:
 *   - SALESINVOICE      (Firebird) → salesinvoice      (MySQL)
 *   - SALESINVOICEDETAIL(Firebird) → salesinvoicedetail(MySQL)
 *
 * - Trabajo por lotes
 * - FULL REFRESH opcional (TRUNCATE detalle + maestro, respetando FK)
 * - No envía campos BLOB (NOTES, BILLTOMEMO, SHIPTOMEMO) → quedan NULL
 * - Cualquier valor "raro" (objeto) de Firebird se normaliza a NULL
 * - Si vuelve a fallar val.slice, loguea qué columna/valor fue el problema
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateSalesInvoices_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// ==========================
// Columnas SALESINVOICE (sin NOTES, BILLTOMEMO, SHIPTOMEMO) - TODAS EN MAYÚSCULAS
// ==========================
const SALESINVOICE_COLUMNS = [
  'ARTRANSID',
  'SALESORDERID',
  'WARRANTYCLAIMID',
  'LOCATIONID',
  'DEPARTMENTID',
  'DIVISIONID',
  'FUNDID',
  'CUSTOMERID',
  'CUSTOMERNAME',
  'BILLTOCUSTOMERID',
  'CUSTOMERPRICELEVEL',
  'SHIPTOID',
  'ORDERDATE',
  'SHIPDATE',
  'TERMS',
  'SALESREP',
  'SHIPVIA',
  'REFERENCE',
  'VATCODE',
  'VATLICENSE',
  'SALESTAXCODE',
  'SALESTAXLICENSE',
  // 'NOTES',        // BLOB → NO se envía
  'NETAMOUNT',
  'SALESTAXAMOUNT',
  'VATTAXAMOUNT',
  'PAYMENTAMOUNT',
  'CHANGEAMOUNT',
  'ARTYPE',
  'TRANSDATE',
  'TRANSTIME',
  'ARAMOUNT',
  'ENTRYDATE',
  'ORIGINUSERID',
  'ORIGINTASKID',
  'ORIGINTRANSID',
  // 'BILLTOMEMO',   // BLOB → NO se envía
  // 'SHIPTOMEMO',   // BLOB → NO se envía
  'SHIPTOCUSTOMERID',
  'ISINVOICETAXABLE',
  'JOBID',
  'ORIGINCOMPUTERNAME',
  'GLTRANSID',
  'NAMESEARCH',
  'SOORIGINTASKID',
  'OTHERFEESTAXES',
  'MAINSALESREP',
  'CUSTSALESREP',
  'ISSALESTAXOVERRIDE',
  'SHIPPED',
  'MANDATORYCONTACT',
];

// ==========================
// Columnas SALESINVOICEDETAIL - TODAS EN MAYÚSCULAS
// ==========================
const SALESINVOICEDETAIL_COLUMNS = [
  'ITEMID',
  'ARTRANSID',
  'MFRID',
  'PARTNUMBER',
  'PRODUCTSERIALNUMBER',
  'ALLOCATEDAPPID',
  'ALLOCATEDITEMID',
  'DESCRIPTION',
  'ONORDERQUANTITY',
  'SHIPPEDQUANTITY',
  'BACKORDERQUANTITY',
  'PRICE',
  'NET',
  'NETAMOUNT',
  'VATCODE',
  'VATTAXAMOUNT',
  'SALESTAXCLASS',
  'COMMISSIONRATE',
  'COMMISSIONAMOUNT',
  'SALESREP',
  'CATEGORY',
  'REVENUEACCOUNTID',
  'ASSETACCOUNTID',
  'OFFSETACCOUNTID',
  'CUSTOMERPRODUCTID',
  'ICQUANTITY',
  'ICCOSTAMOUNT',
  'ICQUANTITYBALANCE',
  'ICCOSTBALANCE',
  'ICLOCATIONID',
  'APPID',
  'GLCOSTBALANCE',
  'PRODUCTTYPE',
  'ORIGMFRID',
  'ORIGPARTNUMBER',
  'SETITEMID',
  'HOURSBILLED',
  'STOCKNUMBER',
  'STOCKUNITLISTPRICE',
  'ITEMIZE',
  'CORERETURNEDQUANTITY',
  'CORECHARGE',
  'CORERETURNRECEIPTITEMID',
  'CORERETURNRECEIPTAPPID',
  'CORERETURNISSUEITEMID',
  'CORERETURNISSUEAPPID',
  'FIITEM',
  'WORKORDERJOBID',
  'ORIGINVOICEITEMID',
  'DEALEROPTIONSTOCKNUM',
];

// Normaliza valores que vienen de Firebird antes de mandarlos a MySQL
function normalizeFbValue(val) {
  if (val === null || val === undefined) return null;

  if (val instanceof Date) return val;
  if (Buffer.isBuffer(val)) return val;

  const t = typeof val;
  if (t === 'string' || t === 'number' || t === 'boolean') return val;

  // Cualquier otro tipo (objetos especiales, etc.) → NULL
  return null;
}

// Loguea el primer valor "raro" en un chunk, para debug
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

async function migrateSalesInvoices() {
  const startTime = Date.now();
  const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
  const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
  const fullRefresh = (process.env.FULL_REFRESH_SALESINVOICE || 'true').toLowerCase() === 'true';

  log.info('🚀 Iniciando migración de SALESINVOICE + SALESINVOICEDETAIL (Firebird) → MySQL...');
  log.info(`⚙️  FB_BATCH_SIZE = ${fbBatchSize}, MYSQL_BATCH_SIZE = ${mysqlBatchSize}`);
  log.info(`⚙️  FULL_REFRESH_SALESINVOICE (maestro+detalle) = ${fullRefresh}`);

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

    // FULL REFRESH: truncar detalle y maestro
    if (fullRefresh) {
      log.info('🧹 FULL REFRESH activado: deshabilitar FK y truncar detalle + maestro...');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');
      await mysqlConn.query('TRUNCATE TABLE salesinvoicedetail');
      await mysqlConn.query('TRUNCATE TABLE salesinvoice');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
      log.info('✅ Tablas salesinvoicedetail y salesinvoice vaciadas.');
    }

    // =====================================================
    // 1) MIGRAR SALESINVOICE (MAESTRO)
    // =====================================================
    const siColumnList = SALESINVOICE_COLUMNS.map(c => `\`${c}\``).join(', ');
    const siUpdateAssignments = SALESINVOICE_COLUMNS
      .filter(c => c !== 'ARTRANSID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const siInsertSQL = `
      INSERT INTO salesinvoice (${siColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${siUpdateAssignments}
    `;

    let offset = 0;
    let globalProcessedSI = 0;
    let fbBatchNumberSI = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberSI += 1;

      log.info(
        `📥 [MAESTRO] Leyendo lote Firebird #${fbBatchNumberSI} (ROWS ${startRow} TO ${endRow}) de SALESINVOICE...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM SALESINVOICE
          ORDER BY ARTRANSID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [MAESTRO] No hay más registros en SALESINVOICE. Fin de la lectura.');
        break;
      }

      log.info(`📊 [MAESTRO] Lote Firebird #${fbBatchNumberSI}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          SALESINVOICE_COLUMNS.map(col => {
            const fbCol = col; // ya está en MAYÚSCULAS
            return normalizeFbValue(row[fbCol]);
          })
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [MAESTRO] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberSI} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(siInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [MAESTRO] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('salesinvoice', SALESINVOICE_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedSI += values.length;

        log.info(
          `✅ [MAESTRO] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total maestro: ${globalProcessedSI}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [MAESTRO] Terminado lote Firebird #${fbBatchNumberSI}. OFFSET ahora: ${offset}. Total maestro: ${globalProcessedSI}.`
      );
    }

    log.info('🎉 Migración de SALESINVOICE (maestro) completada.');
    log.info(`📌 Total registros maestro procesados: ${globalProcessedSI}`);

    // =====================================================
    // 2) MIGRAR SALESINVOICEDETAIL (DETALLE)
    // =====================================================
    const sidColumnList = SALESINVOICEDETAIL_COLUMNS.map(c => `\`${c}\``).join(', ');
    const sidUpdateAssignments = SALESINVOICEDETAIL_COLUMNS
      .filter(c => c !== 'ITEMID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const sidInsertSQL = `
      INSERT INTO salesinvoicedetail (${sidColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${sidUpdateAssignments}
    `;

    offset = 0;
    let globalProcessedSID = 0;
    let fbBatchNumberSID = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberSID += 1;

      log.info(
        `📥 [DETALLE] Leyendo lote Firebird #${fbBatchNumberSID} (ROWS ${startRow} TO ${endRow}) de SALESINVOICEDETAIL...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM SALESINVOICEDETAIL
          ORDER BY ITEMID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [DETALLE] No hay más registros en SALESINVOICEDETAIL. Fin de la lectura.');
        break;
      }

      log.info(`📊 [DETALLE] Lote Firebird #${fbBatchNumberSID}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          SALESINVOICEDETAIL_COLUMNS.map(col => {
            const fbCol = col; // ya está en MAYÚSCULAS
            return normalizeFbValue(row[fbCol]);
          })
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [DETALLE] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberSID} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(sidInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [DETALLE] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('salesinvoicedetail', SALESINVOICEDETAIL_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedSID += values.length;

        log.info(
          `✅ [DETALLE] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total detalle: ${globalProcessedSID}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [DETALLE] Terminado lote Firebird #${fbBatchNumberSID}. OFFSET ahora: ${offset}. Total detalle: ${globalProcessedSID}.`
      );
    }

    log.info('🎉 Migración de SALESINVOICEDETAIL (detalle) completada.');
    log.info(`📌 Total registros detalle procesados: ${globalProcessedSID}`);
  } catch (err) {
    log.error('❌ Error general durante la migración de SALESINVOICE/DETAIL', err);
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
  migrateSalesInvoices();
}

module.exports = migrateSalesInvoices;
