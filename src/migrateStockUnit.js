// src/migrateStockUnit.js
/**
 * Migra:
 *   - STOCKUNIT (Firebird) -> stockunit (MySQL)
 *
 * Notas:
 * - Excluye columnas problemáticas (BLOB/TEXT): NOTES
 * - Trabajo por lotes Firebird -> MySQL
 * - FULL REFRESH opcional por env FULL_REFRESH_STOCKUNIT=true
 */

require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateStockUnit_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// Sin NOTES (BLOB SUB_TYPE TEXT)
const STOCKUNIT_COLUMNS = [
  'STOCKNUMBER',
  'MFRID',
  'PARTNUMBER',
  'PRODUCTSERIALNUMBER',
  'MODELYEAR',
  'LISTPRICE',
  'WARRANTYMONTHS',
  'ENGINEMFRID',
  'FIELD1',
  'FIELD2',
  'FIELD3',
  'ENGINEMODELNUMBER',
  'ENGINESERIALNUMBER',
  'CUSTOMERID',
  'SALESDATE',
  'ORIGINALSOLDBY',
  'METER',
  'APTRANSID',
  'FLOORPLANDUEDATE',
  'SUPPLIERID',
  'SUPPLIERINVOICEID',
  'PAYMENTDATE',
  'PAYMENTCHECKID',
  'RECEIPTDATE',
  'CUSTOMERINVOICEID',
  'LOCATIONID',
  'FINANCERATE',
  'WARRANTYEXPDATE',
  'USED',
  'DESCRIPTION',
  'CATEGORY',
  'MSRP',
  'FREIGHTCHARGE',
  'PREPCHARGE',
  'MISCCHARGE1',
  'MISCCHARGE2',
  'MISCCHARGE3',
  'MISCCHARGE4',
  'UNITSTATUS',
  'CYLINDERS',
  'HP',
  'BODYTYPE',
  'KEYNUMBER',
  'SERIALNUMBER2',
  'SERIALNUMBER3',
  'ONHOLD',
  'ONHOLDREASON',
  'ONHOLDSALESORDERID',
  'REBATEAMOUNT',
  'REBATEPERCENT',
  'REBATEPERCENTTYPE',
  'HOLDBACKAMOUNT',
  'HOLDBACKPERCENT',
  'HOLDBACKTYPE',
  'REBATE2AMOUNT',
  'REBATE2PERCENT',
  'REBATE2PERCENTTYPE',
  'COLOR',
  'REBATECOSTUNIT',
  'REBATE2COSTUNIT',
  'WARRANTYHOURS',
  'WARRANTYMETER',
  'CONDITION',
  'STOCKUNITINFOTYPE',
  'STOCKUNITINFOID',
  'FUELCAPACITY',
  'WARRANTYSTARTDATE',
  'DECKSIZE',
  'ENGINETYPE',
  'ISREGISTERED',
  'FINANCECOMPANYLOANID',
  'FINANCECOMPANYMFRID',
  'FINANCECOMPANYPRODUCTID',
  'BINLOCATION',
  'REGISTEREDDATE',
  'LASTCHANGEDATE',
  'SECONDMFRID',
  'SECONDMODELNUMBER',
  'SECONDSERIALNUMBER',
  'SECONDSERNUMDESC',
  'THIRDMFRID',
  'THIRDMODELNUMBER',
  'THIRDSERIALNUMBER',
  'THIRDSERNUMDESC',
  'FOURTHMFRID',
  'FOURTHMODELNUMBER',
  'FOURTHSERIALNUMBER',
  'FOURTHSERNUMDESC',
  'FIFTHMFRID',
  'FIFTHMODELNUMBER',
  'FIFTHSERIALNUMBER',
  'FIFTHSERNUMDESC',
];

function normalizeFbValue(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val;
  if (Buffer.isBuffer(val)) return val;

  const t = typeof val;
  if (t === 'string' || t === 'number' || t === 'boolean') return val;

  return null;
}

function fbSelectExpr(col) {
  // CONDITION puede ser sensible por palabra reservada
  if (col === 'CONDITION') return '"CONDITION"';
  return col;
}

async function migrateStockUnit() {
  const startTime = Date.now();
  const fbBatchSize = Number(process.env.FB_BATCH_SIZE || 5000);
  const mysqlBatchSize = Number(process.env.MYSQL_BATCH_SIZE || 1000);
  const fullRefresh = (process.env.FULL_REFRESH_STOCKUNIT || 'false').toLowerCase() === 'true';

  let fbDb = null;
  let mysqlConn = null;

  try {
    log.info('Iniciando migracion STOCKUNIT (Firebird -> MySQL)...');
    log.info(`FB_BATCH_SIZE=${fbBatchSize}, MYSQL_BATCH_SIZE=${mysqlBatchSize}, FULL_REFRESH_STOCKUNIT=${fullRefresh}`);

    fbDb = await getFirebirdConnection();
    mysqlConn = await getMySqlConnection();

    if (fullRefresh) {
      log.info('FULL REFRESH activado: truncando stockunit...');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');
      await mysqlConn.query('TRUNCATE TABLE stockunit');
      await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
      log.info('Tabla stockunit vaciada.');
    }

    const mysqlCols = STOCKUNIT_COLUMNS.map(c => `\`${c}\``).join(', ');
    const updateAssignments = STOCKUNIT_COLUMNS
      .filter(c => c !== 'STOCKNUMBER')
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    const insertSql = `
      INSERT INTO stockunit (${mysqlCols})
      VALUES ?
      ON DUPLICATE KEY UPDATE ${updateAssignments}
    `;

    const fbSelectList = ['STOCKNUMBER', ...STOCKUNIT_COLUMNS.filter(c => c !== 'STOCKNUMBER')]
      .map(fbSelectExpr)
      .join(', ');

    let startRow = 1;
    let fbBatchNumber = 0;
    let totalRead = 0;
    let totalUpserted = 0;

    while (true) {
      const endRow = startRow + fbBatchSize - 1;
      fbBatchNumber += 1;

      const fbSql = `
        SELECT ${fbSelectList}
        FROM STOCKUNIT
        ORDER BY STOCKNUMBER
        ROWS ${startRow} TO ${endRow}
      `;

      const rows = await fbQuery(fbDb, fbSql);
      if (!rows || rows.length === 0) {
        log.info('No hay mas registros en STOCKUNIT. Fin.');
        break;
      }

      totalRead += rows.length;
      log.info(`[FB lote ${fbBatchNumber}] Leidos: ${rows.length} (acumulado ${totalRead})`);

      const values = rows.map(r =>
        STOCKUNIT_COLUMNS.map(col => normalizeFbValue(r[col]))
      );

      for (let i = 0; i < values.length; i += mysqlBatchSize) {
        const chunk = values.slice(i, i + mysqlBatchSize);
        const [result] = await mysqlConn.query(insertSql, [chunk]);
        totalUpserted += Number(result.affectedRows || 0);
      }

      startRow += fbBatchSize;
    }

    const [[{ total }]] = await mysqlConn.query('SELECT COUNT(*) AS total FROM stockunit');
    log.info(`Migracion STOCKUNIT completada. Filas en destino: ${total}. affectedRows acumulado: ${totalUpserted}`);
  } catch (err) {
    log.error('Error en migracion STOCKUNIT', err);
    process.exitCode = 1;
  } finally {
    try {
      if (fbDb) fbDb.detach();
    } catch (_) {}
    try {
      if (mysqlConn) await mysqlConn.end();
    } catch (_) {}

    const sec = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info(`Duracion total: ${sec}s`);
  }
}

if (require.main === module) {
  migrateStockUnit();
}

module.exports = migrateStockUnit;
