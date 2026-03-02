// src/migrateProductLocation.js
/**
 * MIGRACIÓN DE PRODUCTLOCATION (Firebird) → productlocation (MySQL)
 * Diseñado para tablas grandes: lectura por lotes desde Firebird y escritura por lotes en MySQL.
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateProductLocation_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// Columnas en MAYÚSCULAS tal como vienen en Firebird
const COLUMNS = [
  'MFRID',
  'PARTNUMBER',
  'LOCATIONID',
  'ONHANDAVAILABLEQUANTITY',
  'FROZENDATE',
  'FROZENOHAQ',
  'COMPOSITEKEY',
];

async function migrateProductLocation() {
  const startTime = Date.now();
  const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
  const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);

  log.info('🚀 Iniciando migración de PRODUCTLOCATION (Firebird) → productlocation (MySQL)...');
  log.info(`⚙️ FB_BATCH_SIZE = ${fbBatchSize}, MYSQL_BATCH_SIZE = ${mysqlBatchSize}`);

  let fbDb = null;
  let mysqlConn = null;

  try {
    // Conexión Firebird
    log.info('🔌 Conectando a Firebird (IDEAL)...');
    fbDb = await getFirebirdConnection();
    log.info('✅ Conectado a Firebird.');

    // Conexión MySQL
    log.info('🔌 Conectando a MySQL...');
    mysqlConn = await getMySqlConnection();
    log.info('✅ Conectado a MySQL.');

    // Preparación de INSERT con UPSERT
    const columnList = COLUMNS.map(c => `\`${c}\``).join(', ');

    const updateAssignments = COLUMNS
      .filter(c => !['MFRID', 'PARTNUMBER', 'LOCATIONID'].includes(c)) // PK
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const insertSQL = `
      INSERT INTO productlocation (${columnList})
      VALUES ?
      ON DUPLICATE KEY UPDATE
      ${updateAssignments}
    `;

    let offset = 0;
    let globalProcessed = 0;
    let fbBatchNumber = 0;

    while (true) {
      const startRow = offset + 1;
      const endRow = offset + fbBatchSize;
      fbBatchNumber++;

      log.info(`📥 Leyendo lote Firebird #${fbBatchNumber} (ROWS ${startRow} TO ${endRow})...`);

      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM PRODUCTLOCATION
          ORDER BY MFRID, PARTNUMBER, LOCATIONID
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('🏁 No hay más registros en PRODUCTLOCATION.');
        break;
      }

      log.info(`📊 Lote Firebird #${fbBatchNumber}: ${fbRows.length} registros obtenidos.`);

      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          COLUMNS.map(col => row[col]) // 🔥 columnas en MAYÚSCULAS, directas
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 Enviando a MySQL lote interno #${mysqlBatchNumber} del lote Firebird #${fbBatchNumber}... (${values.length} registros)`
        );

        await mysqlConn.query(insertSQL, [values]);

        localProcessed += values.length;
        globalProcessed += values.length;

        log.info(`✅ Lote interno #${mysqlBatchNumber} OK. Total procesado en lote FB: ${localProcessed}. Total global: ${globalProcessed}.`);
      }

      offset += fbBatchSize;
      log.info(`➡️ Terminado lote Firebird #${fbBatchNumber}. OFFSET=${offset}, Total Global=${globalProcessed}`);
    }

    log.info('🎉 Migración PRODUCTLOCATION completada correctamente.');
    log.info(`📌 Total registros procesados: ${globalProcessed}`);

  } catch (err) {
    log.error('❌ Error en migración PRODUCTLOCATION', err);
  } finally {
    const time = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info(`⏱ Duración total: ${time} segundos`);

    if (fbDb) {
      try { fbDb.detach(); log.info('🔚 Conexión Firebird cerrada.'); }
      catch (e) { log.warn('⚠ Error cerrando Firebird', e); }
    }

    if (mysqlConn) {
      try { await mysqlConn.end(); log.info('🔚 Conexión MySQL cerrada.'); }
      catch (e) { log.warn('⚠ Error cerrando MySQL', e); }
    }
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  migrateProductLocation();
}

module.exports = migrateProductLocation;
