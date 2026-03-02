// src/migratePOReceipts.js
/**
 * Migra:
 *   - PORECEIPT      (Firebird) → poreceipt      (MySQL)
 *   - PORECEIPTDETAIL(Firebird) → poreceiptdetail(MySQL)
 *
 * - Trabajo por lotes
 * - FULL REFRESH opcional (TRUNCATE detalle + maestro, respetando FK)
 * - No envía campos BLOB (NOTES, ADDITIONALCOSTS) → quedan NULL
 * - Cualquier valor "raro" (objeto) de Firebird se normaliza a NULL
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migratePOReceipts_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// ==========================
// Columnas PORECEIPT (sin NOTES, ADDITIONALCOSTS) - MAYÚSCULAS
// ==========================
const PORECEIPT_COLUMNS = [
  'PORECEIPTID',
  'PURCHASEORDERID',
  'LOCATIONID',
  'SUPPLIERID',
  'TERMS',
  'TRANSDATE',
  'REFERENCE',
  'AMOUNT',
  'ENTRYDATE',
  'ORIGINUSERID',
  'ORIGINTASKID',
  'ORIGINTRANSID',
  'ORIGINBATCHID',
  'ORDERFROMID',
  'SHIPVIA',
  'APTRANSID',
  'TRANSTIME',
  'ORIGINCOMPUTERNAME',
  'APSUPPLIERID',
  'GLTRANSID',
  // 'NOTES',           // BLOB → NO se envía
  'RECEIVINGPERSON',
  // 'ADDITIONALCOSTS', // BLOB → NO se envía
];

// ==========================
// Columnas PORECEIPTDETAIL - MAYÚSCULAS
// ==========================
const PORECEIPTDETAIL_COLUMNS = [
  'ITEMID',
  'PORECEIPTID',
  'PURCHASEORDERDETAILITEMID',
  'DESCRIPTION',
  'VATCODE',
  'ICQUANTITY',
  'ICCOSTAMOUNT',
  'ICQUANTITYBALANCE',
  'ICCOSTBALANCE',
  'MFRID',
  'PARTNUMBER',
  'PRODUCTSERIALNUMBER',
  'JOBID',
  'LABELQUANTITY',
  'ALLOCATEDAPPID',
  'ALLOCATEDITEMID',
  'ICLOCATIONID',
  'APPID',
  'ASSETACCOUNTID',
  'OFFSETACCOUNTID',
  'GLCOSTBALANCE',
  'PURCHASESALESRATIO',
  'PURCHASEUNITOFMEASURE',
  'CATEGORY',
  'PRODUCTTYPE',
  'SUPPLIERMFRID',
  'SUPPLIERPRODUCTID',
  'RECEIVEDQTY',
  'STOCKNUMBER',
  'CORERETURNEDQUANTITY',
  'CORECOST',
  'CORERETURNRECEIPTITEMID',
  'CORERETURNRECEIPTAPPID',
  'CORERETURNISSUEITEMID',
  'CORERETURNISSUEAPPID',
  'ADDITIONALCOST',
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

async function migratePOReceipts() {
  const startTime = Date.now();
  const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
  const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
  const fullRefresh = (process.env.FULL_REFRESH_PORECEIPT || 'false').toLowerCase() === 'true';

  log.info('🚀 Iniciando migración de PORECEIPT + PORECEIPTDETAIL (Firebird) → MySQL...');
  log.info(`⚙️  FB_BATCH_SIZE = ${fbBatchSize}, MYSQL_BATCH_SIZE = ${mysqlBatchSize}`);
  log.info(`⚙️  FULL_REFRESH_PORECEIPT (maestro+detalle) = ${fullRefresh}`);

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
      await mysqlConn.query('TRUNCATE TABLE poreceiptdetail');
      await mysqlConn.query('TRUNCATE TABLE poreceipt');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
      log.info('✅ Tablas poreceiptdetail y poreceipt vaciadas.');
    }

    // =====================================================
    // 1) MIGRAR PORECEIPT (MAESTRO)
    // =====================================================
    const prColumnList = PORECEIPT_COLUMNS.map(c => `\`${c}\``).join(', ');
    const prUpdateAssignments = PORECEIPT_COLUMNS
      .filter(c => c !== 'PORECEIPTID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const prInsertSQL = `
      INSERT INTO poreceipt (${prColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${prUpdateAssignments}
    `;

    let offset = 0;
    let globalProcessedPR = 0;
    let fbBatchNumberPR = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberPR += 1;

      log.info(
        `📥 [PORECEIPT] Leyendo lote Firebird #${fbBatchNumberPR} (ROWS ${startRow} TO ${endRow}) de PORECEIPT...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM PORECEIPT
          ORDER BY PORECEIPTID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [PORECEIPT] No hay más registros en PORECEIPT. Fin de la lectura.');
        break;
      }

      log.info(`📊 [PORECEIPT] Lote Firebird #${fbBatchNumberPR}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          PORECEIPT_COLUMNS.map(col => normalizeFbValue(row[col]))
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [PORECEIPT] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberPR} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(prInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [PORECEIPT] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('poreceipt', PORECEIPT_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedPR += values.length;

        log.info(
          `✅ [PORECEIPT] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total maestro: ${globalProcessedPR}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [PORECEIPT] Terminado lote Firebird #${fbBatchNumberPR}. OFFSET ahora: ${offset}. Total maestro: ${globalProcessedPR}.`
      );
    }

    log.info('🎉 Migración de PORECEIPT (maestro) completada.');
    log.info(`📌 Total registros maestro procesados: ${globalProcessedPR}`);

    // =====================================================
    // 2) MIGRAR PORECEIPTDETAIL (DETALLE)
    // =====================================================
    const prdColumnList = PORECEIPTDETAIL_COLUMNS.map(c => `\`${c}\``).join(', ');
    const prdUpdateAssignments = PORECEIPTDETAIL_COLUMNS
      .filter(c => c !== 'ITEMID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const prdInsertSQL = `
      INSERT INTO poreceiptdetail (${prdColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${prdUpdateAssignments}
    `;

    offset = 0;
    let globalProcessedPRD = 0;
    let fbBatchNumberPRD = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberPRD += 1;

      log.info(
        `📥 [PORECEIPTDETAIL] Leyendo lote Firebird #${fbBatchNumberPRD} (ROWS ${startRow} TO ${endRow}) de PORECEIPTDETAIL...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM PORECEIPTDETAIL
          ORDER BY ITEMID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [PORECEIPTDETAIL] No hay más registros en PORECEIPTDETAIL. Fin de la lectura.');
        break;
      }

      log.info(`📊 [PORECEIPTDETAIL] Lote Firebird #${fbBatchNumberPRD}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          PORECEIPTDETAIL_COLUMNS.map(col => normalizeFbValue(row[col]))
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [PORECEIPTDETAIL] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberPRD} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(prdInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [PORECEIPTDETAIL] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('poreceiptdetail', PORECEIPTDETAIL_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedPRD += values.length;

        log.info(
          `✅ [PORECEIPTDETAIL] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total detalle: ${globalProcessedPRD}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [PORECEIPTDETAIL] Terminado lote Firebird #${fbBatchNumberPRD}. OFFSET ahora: ${offset}. Total detalle: ${globalProcessedPRD}.`
      );
    }

    log.info('🎉 Migración de PORECEIPTDETAIL (detalle) completada.');
    log.info(`📌 Total registros detalle procesados: ${globalProcessedPRD}`);
  } catch (err) {
    log.error('❌ Error general durante la migración de PORECEIPT/DETAIL', err);
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
  migratePOReceipts();
}

module.exports = migratePOReceipts;
