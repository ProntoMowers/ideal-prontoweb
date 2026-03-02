// src/migrateProductIdeal.js
/**
 * MIGRACIÓN DE PRODUCTOS DESDE IDEAL (Firebird) A MySQL (tabla product)
 * Diseñado para tablas grandes: lectura por lotes desde Firebird y escritura por lotes en MySQL.
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateProductIdeal_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// Columnas exactas de la tabla PRODUCT/product en el mismo orden (MAYÚSCULAS)
const COLUMNS = [
  'MFRID',
  'PARTNUMBER',
  'DESCRIPTION',
  'LOOKUPPARTNUMBER',
  'CATEGORY',
  'PRODUCTTYPE',
  'STATUS',
  'SUPERCEDETO',
  'PRODUCTCOMMISSIONCODE',
  'VATCODE',
  'SALESTAXCLASS',
  'STOCKCODE',
  'PRICEHOLD',
  'WARRANTYMONTHS',
  'FIELD1',
  'FIELD2',
  'FIELD3',
  'UNITOFMEASURE',
  'PURCHASEUNITOFMEASURE',
  'PACKAGEQUANTITY',
  'PURCHASESALESRATIO',
  'MINIMUMORDERQUANTITY',
  'WEIGHT',
  'UPC',
  'MFRDISCOUNTCODE',
  'PRODUCTPRICECODE',
  'QTYDISCOUNTCODE',
  'ROUNDTO',
  'SUBTRACT',
  'ASSETACCOUNTID',
  'REVENUEACCOUNTID',
  'EXPENSEACCOUNTID',
  'PREFERREDSUPPLIERID',
  'LISTPRICE',
  'MINIMUMPRICE',
  'STANDARDCOST',
  'LIFOFIFOAVERAGECOST',
  'AVERAGECOST',
  'CURRENTCOST',
  'SUPERCEDEMFRID',
  'DESCRIPTIONSEARCH',
  'FREIGHTCOST',
  'CORECOST',
  'OTHERCOST',
  'FREIGHTCHARGE',
  'FREIGHTCHARGEPARTNUMBER',
  'FREIGHTCHARGEMFRID',
  'CORECHARGE',
  'CORECHARGEPARTNUMBER',
  'CORECHARGEMFRID',
  'OTHERCHARGE',
  'OTHERCHARGEPARTNUMBER',
  'OTHERCHARGEMFRID',
  'ACCESSORYCHARGEMFRID',
  'ACCESSORYCHARGEPARTNUMBER',
  'DOEXPORTTOSHOPCART',
  'PREVIOUSMFRLISTPRICE',
  'PREVIOUSMFRCOST',
  'SHOPCARTEXPORTED',
  'CORECOST1',
  'CORECHARGE1',
  'HASCORE',
  'STOCKUNITINFOTYPE',
  'LASTCHANGEDATE',
];

async function migrateProductIdeal() {
  const startTime = Date.now();
  const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
  const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);

  log.info('🚀 Iniciando migración de PRODUCT (Firebird) → product (MySQL)...');
  log.info(`⚙️  FB_BATCH_SIZE = ${fbBatchSize}, MYSQL_BATCH_SIZE = ${mysqlBatchSize}`);

  let fbDb = null;
  let mysqlConn = null;

  try {
    // Conectar a Firebird (IDEAL)
    log.info('🔌 Conectando a Firebird (IDEAL)...');
    fbDb = await getFirebirdConnection();
    log.info('✅ Conectado a Firebird.');

    // Conectar a MySQL
    log.info('🔌 Conectando a MySQL...');
    mysqlConn = await getMySqlConnection();
    log.info('✅ Conectado a MySQL.');

    // Preparar sentencia INSERT con ON DUPLICATE KEY UPDATE
    const columnList = COLUMNS.map(c => `\`${c}\``).join(', ');

    const updateAssignments = COLUMNS
      .filter(c => !['MFRID', 'PARTNUMBER'].includes(c)) // PK compuesta
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const insertSQL = `
      INSERT INTO product (${columnList})
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

      fbBatchNumber += 1;
      log.info(
        `📥 Leyendo lote Firebird #${fbBatchNumber} (ROWS ${startRow} TO ${endRow})...`
      );

      // Lectura paginada desde Firebird
      const fbRows = await fbQuery(
        fbDb,
        `
          SELECT *
          FROM PRODUCT
          ORDER BY MFRID, PARTNUMBER
          ROWS ? TO ?
        `,
        [startRow, endRow]
      );

      if (!fbRows || fbRows.length === 0) {
        log.info('✅ No hay más registros en PRODUCT. Fin de la lectura.');
        break;
      }

      log.info(`📊 Lote Firebird #${fbBatchNumber}: ${fbRows.length} registros obtenidos.`);

      // Ahora este lote de Firebird lo enviamos a MySQL en sub-lotes
      let localProcessed = 0;

      for (let i = 0; i < fbRows.length; i += mysqlBatchSize) {
        const chunk = fbRows.slice(i, i + mysqlBatchSize);

        const values = chunk.map(row =>
          COLUMNS.map(col => row[col]) // usamos el nombre en MAYÚSCULAS directamente
        );

        const mysqlBatchNumber = Math.floor(i / mysqlBatchSize) + 1;

        log.info(
          `💾 Enviando a MySQL lote interno #${mysqlBatchNumber} de Firebird #${fbBatchNumber} (${values.length} registros)...`
        );

        await mysqlConn.query(insertSQL, [values]);

        localProcessed += values.length;
        globalProcessed += values.length;

        log.info(
          `✅ Lote interno #${mysqlBatchNumber} procesado. ` +
          `Procesados en este lote Firebird: ${localProcessed}. Total global: ${globalProcessed}.`
        );
      }

      // Avanzamos el OFFSET para el siguiente lote de Firebird
      offset += fbBatchSize;
      log.info(
        `➡️ Terminado lote Firebird #${fbBatchNumber}. OFFSET ahora: ${offset}. Total global: ${globalProcessed}.`
      );
    }

    log.info('🎉 Migración completada correctamente.');
    log.info(`📌 Registros totales procesados: ${globalProcessed}`);
  } catch (err) {
    log.error('❌ Error durante la migración', err);
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
  migrateProductIdeal();
}

module.exports = migrateProductIdeal;
