// src/migrateICTrans.js
/**
 * Migra:
 *   - ICTRANS      (Firebird) → ictrans      (MySQL)
 *   - ICTRANSDETAIL(Firebird) → ictransdetail(MySQL)
 *
 * - Trabajo por lotes
 * - FULL REFRESH opcional (TRUNCATE detalle + maestro, respetando FK)
 * - No envía el campo BLOB NOTES → queda NULL
 * - Cualquier valor "raro" (objeto) de Firebird se normaliza a NULL
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateICTrans_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// ==========================
// Columnas ICTRANS (sin NOTES) - MAYÚSCULAS
// ==========================
const ICTRANS_COLUMNS = [
  'ICTRANSID',
  'ICTYPE',
  'LOCATIONID',
  'TRANSDATE',
  'REFERENCE',
  // 'NOTES',        // BLOB → NO se envía
  'ENTRYDATE',
  'ORIGINUSERID',
  'ORIGINTASKID',
  'ORIGINTRANSID',
  'ERRORID',
  'JOBID',
  'BMORDERID',
  'ADJUSTMENTACCOUNTID',
  'GLTRANSID',
  'TRANSTIME',
  'ORIGINCOMPUTERNAME',
];

// ==========================
// Columnas ICTRANSDETAIL - MAYÚSCULAS
// ==========================
const ICTRANSDETAIL_COLUMNS = [
  'ITEMID',
  'ICTRANSID',
  'MFRID',
  'PARTNUMBER',
  'ICQUANTITY',
  'ICCOSTAMOUNT',
  'ICQUANTITYBALANCE',
  'ICCOSTBALANCE',
  'PRODUCTSERIALNUMBER',
  'ASSETACCOUNTID',
  'ALLOCATEDAPPID',
  'ALLOCATEDITEMID',
  'ICLOCATIONID',
  'APPID',
  'OFFSETACCOUNTID',
  'GLCOSTBALANCE',
  'STOCKNUMBER',
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

async function migrateICTrans() {
  const startTime = Date.now();
  const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
  const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
  const fullRefresh = (process.env.FULL_REFRESH_ICTRANS || 'false').toLowerCase() === 'true';

  log.info('🚀 Iniciando migración de ICTRANS + ICTRANSDETAIL (Firebird) → MySQL...');
  log.info(`⚙️  FB_BATCH_SIZE = ${fbBatchSize}, MYSQL_BATCH_SIZE = ${mysqlBatchSize}`);
  log.info(`⚙️  FULL_REFRESH_ICTRANS (maestro+detalle) = ${fullRefresh}`);

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
      await mysqlConn.query('TRUNCATE TABLE ictransdetail');
      await mysqlConn.query('TRUNCATE TABLE ictrans');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
      log.info('✅ Tablas ictransdetail y ictrans vaciadas.');
    }

    // =====================================================
    // 1) MIGRAR ICTRANS (MAESTRO)
    // =====================================================
    const itColumnList = ICTRANS_COLUMNS.map(c => `\`${c}\``).join(', ');
    const itUpdateAssignments = ICTRANS_COLUMNS
      .filter(c => c !== 'ICTRANSID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const itInsertSQL = `
      INSERT INTO ictrans (${itColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${itUpdateAssignments}
    `;

    let offset = 0;
    let globalProcessedIT = 0;
    let fbBatchNumberIT = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberIT += 1;

      log.info(
        `📥 [ICTRANS] Leyendo lote Firebird #${fbBatchNumberIT} (ROWS ${startRow} TO ${endRow}) de ICTRANS...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM ICTRANS
          ORDER BY ICTRANSID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [ICTRANS] No hay más registros en ICTRANS. Fin de la lectura.');
        break;
      }

      log.info(`📊 [ICTRANS] Lote Firebird #${fbBatchNumberIT}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          ICTRANS_COLUMNS.map(col => normalizeFbValue(row[col]))
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [ICTRANS] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberIT} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(itInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [ICTRANS] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('ictrans', ICTRANS_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedIT += values.length;

        log.info(
          `✅ [ICTRANS] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total maestro: ${globalProcessedIT}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [ICTRANS] Terminado lote Firebird #${fbBatchNumberIT}. OFFSET ahora: ${offset}. Total maestro: ${globalProcessedIT}.`
      );
    }

    log.info('🎉 Migración de ICTRANS (maestro) completada.');
    log.info(`📌 Total registros maestro procesados: ${globalProcessedIT}`);

    // =====================================================
    // 2) MIGRAR ICTRANSDETAIL (DETALLE)
    // =====================================================
    const itdColumnList = ICTRANSDETAIL_COLUMNS.map(c => `\`${c}\``).join(', ');
    const itdUpdateAssignments = ICTRANSDETAIL_COLUMNS
      .filter(c => c !== 'ITEMID') // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const itdInsertSQL = `
      INSERT INTO ictransdetail (${itdColumnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${itdUpdateAssignments}
    `;

    offset = 0;
    let globalProcessedITD = 0;
    let fbBatchNumberITD = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumberITD += 1;

      log.info(
        `📥 [ICTRANSDETAIL] Leyendo lote Firebird #${fbBatchNumberITD} (ROWS ${startRow} TO ${endRow}) de ICTRANSDETAIL...`
      );

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM ICTRANSDETAIL
          ORDER BY ITEMID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ [ICTRANSDETAIL] No hay más registros en ICTRANSDETAIL. Fin de la lectura.');
        break;
      }

      log.info(`📊 [ICTRANSDETAIL] Lote Firebird #${fbBatchNumberITD}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          ICTRANSDETAIL_COLUMNS.map(col => normalizeFbValue(row[col]))
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 [ICTRANSDETAIL] Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumberITD} (${values.length} registros)...`
        );

        try {
          await mysqlConn.query(itdInsertSQL, [values]);
        } catch (err) {
          log.error('❌ [ICTRANSDETAIL] Error en INSERT batch. Analizando valores...', err);
          logFirstWeirdValue('ictransdetail', ICTRANSDETAIL_COLUMNS, values);
          throw err;
        }

        localProcessed += values.length;
        globalProcessedITD += values.length;

        log.info(
          `✅ [ICTRANSDETAIL] Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total detalle: ${globalProcessedITD}.`
        );
      }

      offset += fbBatchSize;
      log.info(
        `➡️ [ICTRANSDETAIL] Terminado lote Firebird #${fbBatchNumberITD}. OFFSET ahora: ${offset}. Total detalle: ${globalProcessedITD}.`
      );
    }

    log.info('🎉 Migración de ICTRANSDETAIL (detalle) completada.');
    log.info(`📌 Total registros detalle procesados: ${globalProcessedITD}`);
  } catch (err) {
    log.error('❌ Error general durante la migración de ICTRANS/DETAIL', err);
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
  migrateICTrans();
}

module.exports = migrateICTrans;
