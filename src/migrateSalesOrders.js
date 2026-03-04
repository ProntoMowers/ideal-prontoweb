// src/migrateSalesOrders.js
/**
 * Migra:
 *   - SALESORDER      (Firebird) → salesorder      (MySQL)
 *   - SALESORDERDETAIL(Firebird) → salesorderdetail(MySQL)
 *
 * - Trabajo por lotes
 * - FULL REFRESH opcional (TRUNCATE detalle + maestro, respetando FK)
 * - No envía campos BLOB (NOTES, BILLTOMEMO, SHIPTOMEMO, WARNINGNOTES) → quedan NULL
 * - Cualquier valor "raro" (objeto) de Firebird se normaliza a NULL
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateSalesOrders_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// ==========================
// Columnas SALESORDER (sin BLOBs) - MAYÚSCULAS
// ==========================
const SALESORDER_COLUMNS = [
  'SALESORDERID',
  'SALESORDERTYPE',
  'JOBID',
  'LOCATIONID',
  'DEPARTMENTID',
  'DIVISIONID',
  'FUNDID',
  'CUSTOMERID',
  'CUSTOMERNAME',
  'BILLTOCUSTOMERID',
  'SHIPTOID',
  'ISHOLD',
  'HOLDREASON',
  'ISCREDITSTATUSOK',
  'ORDERACTION',
  'ORDERDATE',
  'SHIPDATE',
  'TERMS',
  'SALESREP',
  'CUSTOMERPRICELEVEL',
  'SHIPVIA',
  'REFERENCE',
  'VATCODE',
  'VATLICENSE',
  'SALESTAXCODE',
  'SALESTAXLICENSE',
  // 'NOTES',        // BLOB → NO se envía
  'ENTRYDATE',
  'ORIGINUSERID',
  'ORIGINTASKID',
  'ORIGINTRANSID',
  'RECALCTOTALS',
  'ALLOCATEDSUBTOTAL',
  'ORDEREDSUBTOTAL',
  'ALLOCATEDVATTOTAL',
  'ORDEREDVATTOTAL',
  'ACTIVEDETAILCOUNT',
  'DETAILCOUNT',
  // 'BILLTOMEMO',   // BLOB → NO se envía
  // 'SHIPTOMEMO',   // BLOB → NO se envía
  'SHIPTOCUSTOMERID',
  'ACTIVEUSERID',
  'ISINVOICETAXABLE',
  'ACTIVECOMPUTERNAME',
  'ORDERTIME',
  'CODEGROUPID',
  'SUPPLIERSHIPVIA',
  'DOAPPLYWOPARTSBUMP',
  'ORDERACTIONDATE',
  'SHIPTOITEMID',
  'MAINSALESREP',
  'CHANGEUSERID',
  'CHANGEDATE',
  'CHANGECOMPUTERNAME',
  'TOUCHLESSPAYMENTSTATUS',
  'ISSALESTAXOVERRIDE',
  'SALESTAXOVERRIDE',
  'SHIPPED',
  'ISWARNING',
  // 'WARNINGNOTES', // BLOB → NO se envía
  'MANDATORYCONTACT',
];

// ==========================
// Columnas SALESORDERDETAIL - MAYÚSCULAS
// ==========================
const SALESORDERDETAIL_COLUMNS = [
  'ITEMID',
  'SALESORDERID',
  'MFRID',
  'PARTNUMBER',
  'DESCRIPTION',
  'PRODUCTTYPE',
  'ONORDERQUANTITY',
  'ALLOCATEDQUANTITY',
  'PRICE',
  'NET',
  'VATCODE',
  'SALESTAXCLASS',
  'SALESREP',
  'CATEGORY',
  'WARRANTYCLAIMID',
  'ASSETACCOUNTID',
  'REVENUEACCOUNTID',
  'OFFSETACCOUNTID',
  'CUSTOMERPRODUCTID',
  'ICLOCATIONID',
  'COST',
  'RETURNSERIALNUMBER',
  'ITEMPOSITION',
  'ALLOWMINUSOHAQ',
  'DEPARTMENTID',
  'DIVISIONID',
  'FUNDID',
  'WEIGHT',
  'ORIGMFRID',
  'ORIGPARTNUMBER',
  'SETITEMID',
  'ITEMIZE',
  'STOCKUNITLISTPRICE',
  'APPID',
  'CORERETURNEDQUANTITY',
  'COREITEMID',
  'CORERETURNRECEIPTITEMID',
  'CORERETURNRECEIPTAPPID',
  'CORERETURNISSUEITEMID',
  'CORERETURNISSUEAPPID',
  'WORKORDERJOBID',
  'ORIGINVOICEITEMID',
  'DEALEROPTIONSTOCKNUM',
  'CHANGEUSERID',
  'CHANGEDATE',
  'CHANGECOMPUTERNAME',
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

async function migrateSalesOrders() {
  const startTime = Date.now();
  const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
  const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
  const fullRefresh = (process.env.FULL_REFRESH_SALESORDER || 'true').toLowerCase() === 'true';

  log.info('🚀 Iniciando migración de SALESORDER + SALESORDERDETAIL (Firebird) → MySQL...');
  log.info(`⚙️  FB_BATCH_SIZE = ${fbBatchSize}, MYSQL_BATCH_SIZE = ${mysqlBatchSize}`);
  log.info(`⚙️  FULL_REFRESH_SALESORDER (maestro+detalle) = ${fullRefresh}`);

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
      await mysqlConn.query('TRUNCATE TABLE salesorderdetail');
      await mysqlConn.query('TRUNCATE TABLE salesorder');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
      log.info('✅ Tablas salesorderdetail y salesorder vaciadas.');
    }

    // =====================================================
    // 1) MIGRAR SALESORDER (MAESTRO)
    // =====================================================
    const soColumnList = SALESORDER_COLUMNS.map(c => `\`${c}\``).join(', ');
    const soUpdateAssignments = SALESORDER_COLUMNS
      .filter(c => c !== 'SALESORDERID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const soInsertSQL = `
      INSERT INTO salesorder (${soColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${soUpdateAssignments}
    `;

    let offset = 0;
    let globalProcessedSO = 0;
    let fbBatchNumberSO = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberSO += 1;

      log.info(
        `📥 [SALESORDER] Leyendo lote Firebird #${fbBatchNumberSO} (ROWS ${startRow} TO ${endRow}) de SALESORDER...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM SALESORDER
          ORDER BY SALESORDERID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [SALESORDER] No hay más registros en SALESORDER. Fin de la lectura.');
        break;
      }

      log.info(`📊 [SALESORDER] Lote Firebird #${fbBatchNumberSO}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          SALESORDER_COLUMNS.map(col => normalizeFbValue(row[col])) // 🔥 columnas en MAYÚSCULAS
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [SALESORDER] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberSO} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(soInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [SALESORDER] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('salesorder', SALESORDER_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedSO += values.length;

        log.info(
          `✅ [SALESORDER] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total maestro: ${globalProcessedSO}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [SALESORDER] Terminado lote Firebird #${fbBatchNumberSO}. OFFSET ahora: ${offset}. Total maestro: ${globalProcessedSO}.`
      );
    }

    log.info('🎉 Migración de SALESORDER (maestro) completada.');
    log.info(`📌 Total registros maestro procesados: ${globalProcessedSO}`);

    // =====================================================
    // 2) MIGRAR SALESORDERDETAIL (DETALLE)
    // =====================================================
    const sodColumnList = SALESORDERDETAIL_COLUMNS.map(c => `\`${c}\``).join(', ');
    const sodUpdateAssignments = SALESORDERDETAIL_COLUMNS
      .filter(c => c !== 'ITEMID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const sodInsertSQL = `
      INSERT INTO salesorderdetail (${sodColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${sodUpdateAssignments}
    `;

    offset = 0;
    let globalProcessedSOD = 0;
    let fbBatchNumberSOD = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberSOD += 1;

      log.info(
        `📥 [SALESORDERDETAIL] Leyendo lote Firebird #${fbBatchNumberSOD} (ROWS ${startRow} TO ${endRow}) de SALESORDERDETAIL...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM SALESORDERDETAIL
          ORDER BY ITEMID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [SALESORDERDETAIL] No hay más registros en SALESORDERDETAIL. Fin de la lectura.');
        break;
      }

      log.info(`📊 [SALESORDERDETAIL] Lote Firebird #${fbBatchNumberSOD}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          SALESORDERDETAIL_COLUMNS.map(col => normalizeFbValue(row[col])) // 🔥 columnas en MAYÚSCULAS
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [SALESORDERDETAIL] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberSOD} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(sodInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [SALESORDERDETAIL] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('salesorderdetail', SALESORDERDETAIL_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedSOD += values.length;

        log.info(
          `✅ [SALESORDERDETAIL] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total detalle: ${globalProcessedSOD}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [SALESORDERDETAIL] Terminado lote Firebird #${fbBatchNumberSOD}. OFFSET ahora: ${offset}. Total detalle: ${globalProcessedSOD}.`
      );
    }

    log.info('🎉 Migración de SALESORDERDETAIL (detalle) completada.');
    log.info(`📌 Total registros detalle procesados: ${globalProcessedSOD}`);
  } catch (err) {
    log.error('❌ Error general durante la migración de SALESORDER/DETAIL', err);
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
  migrateSalesOrders();
}

module.exports = migrateSalesOrders;
