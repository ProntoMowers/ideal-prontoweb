require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateARTrans_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// Columnas seguras (Excluyendo BLOBs: NOTES, CCRESULTS)
const AR_COLUMNS = [
    'ARTRANSID', 'CUSTOMERID', 'ARTYPE', 'TRANSDATE', 'REFERENCE', 'ARAMOUNT',
    'ARBALANCE', 'NETDATE', 'CASHDISCOUNTDATE', 'CASHDISCOUNTAMOUNT', 'ISCHARGEINTEREST',
    'BANKDEPOSITGLTRANSID', 'ARSUBLEDGERACCOUNTID', 'GLTRANSID', 'REVERSALARTRANSID',
    'ENTRYDATE', 'ORIGINUSERID', 'ORIGINTASKID', 'ORIGINTRANSID', 'ORIGINBATCHID',
    'INSERTID', 'ERRORID', 'BANKRECONCILEDDATE', 'ORIGINLOCATIONID', 'ORIGINCOMPANYID',
    'ORIGINCOMPUTERNAME', 'CCNUMBER', 'CCEXPMONTH', 'CCEXPYEAR', 'CCRESPCODE',
    'CCAUTH', 'CCCLERK', 'CCCOMMENT', 'CCTOTAL', 'CCBILLTOST', 'CCBILLTOZIP',
    'CCANS', 'STOCKNUMBER', 'CCTRANSACTIONKEY'
];

const ARD_COLUMNS = [
    'ITEMID', 'ARTRANSID', 'ACCOUNTID', 'AMOUNT', 'JOBID', 'BANKRECONCILEDDATE'
];

function normalizeFbValue(val) {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val;
    if (Buffer.isBuffer(val)) return val;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') return val;
    return null;
}

async function runMigrationForTable(fbDb, mysqlConn, config) {
    const { fbTable, mysqlTable, columns, pk, fbBatchSize, mysqlBatchSize } = config;
    let offset = 0;
    let totalProcessed = 0;

    const colList = columns.map(c => `\`${c}\``).join(', ');
    const updateAssignments = columns.filter(c => c !== pk).map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
    const sql = `INSERT INTO ${mysqlTable} (${colList}) VALUES ? ON DUPLICATE KEY UPDATE ${updateAssignments}`;

    while (true) {
        const rows = await fbQuery(fbDb, `SELECT * FROM ${fbTable} ORDER BY ${pk} ROWS ? TO ?`, [offset + 1, offset + fbBatchSize]);
        if (!rows || rows.length === 0) break;

        for (let i = 0; i < rows.length; i += mysqlBatchSize) {
            const chunk = rows.slice(i, i + mysqlBatchSize);
            const values = chunk.map(row => columns.map(col => normalizeFbValue(row[col])));
            await mysqlConn.query(sql, [values]);
            totalProcessed += values.length;
        }
        offset += fbBatchSize;
        log.info(`[${fbTable}] Procesados ${totalProcessed} registros...`);
    }
    log.info(`✅ Finalizado ${fbTable}. Total: ${totalProcessed}`);
}

async function migrateARTrans() {
    const startTime = Date.now();
    const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '50000', 10);
    const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '10000', 10);
    const fullRefresh = (process.env.FULL_REFRESH_ARTRANS || 'true').toLowerCase() === 'true';

    let fbDb, mysqlConn;

    try {
        fbDb = await getFirebirdConnection();
        mysqlConn = await getMySqlConnection();

        if (fullRefresh) {
            log.info('🧹 Limpiando tablas de AR (Full Refresh)...');
            await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');
            await mysqlConn.query('TRUNCATE TABLE artransdetail');
            await mysqlConn.query('TRUNCATE TABLE artrans');
            await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
        }

        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'ARTRANS', mysqlTable: 'artrans', columns: AR_COLUMNS, pk: 'ARTRANSID', fbBatchSize, mysqlBatchSize });
        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'ARTRANSDETAIL', mysqlTable: 'artransdetail', columns: ARD_COLUMNS, pk: 'ITEMID', fbBatchSize, mysqlBatchSize });

    } catch (err) {
        log.error('❌ Error en migración de AR', err);
    } finally {
        if (fbDb) fbDb.detach();
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) migrateARTrans();
module.exports = migrateARTrans;