require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateAccountantTrans_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// Definición de columnas seguras
const ACC_COLUMNS = [
    'ACCOUNTID', 'FINANCIALDESCRIPTION', 'FINANCIALID', 'DEPARTMENTID', 
    'DIVISIONID', 'FUNDID', 'JOBID', 'COSTID', 'INSERTID', 'QBLISTID', 'QBNAME'
];

const GL_COLUMNS = [
    'GLTRANSID', 'GLTYPE', 'TRANSDATE', 'REFERENCE', 'CURRENCYID', 
    'BANKRECONCILEDDATE', 'ALLOCATIONGLTRANSID', 'REVERSALGLTRANSID', 
    'ENTRYDATE', 'ORIGINUSERID', 'ORIGINTASKID', 'ORIGINTRANSID', 
    'ORIGINBATCHID', 'INSERTID', 'ERRORID', 'ORIGINCOMPANYID', 
    'BANKDEPOSITGLTRANSID', 'ORIGINCOMPUTERNAME'
];

const GLD_COLUMNS = [
    'ITEMID', 'GLTRANSID', 'ACCOUNTID', 'AMOUNT', 'JOBID', 'BANKRECONCILEDDATE'
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

async function migrateAccountantTrans() {
    const startTime = Date.now();
    const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
    const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
    const fullRefresh = (process.env.FULL_REFRESH_GLTRANS || 'true').toLowerCase() === 'true';

    let fbDb, mysqlConn;

    try {
        fbDb = await getFirebirdConnection();
        mysqlConn = await getMySqlConnection();

        if (fullRefresh) {
            log.info('🧹 Limpiando tablas contables (Full Refresh)...');
            await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');
            await mysqlConn.query('TRUNCATE TABLE gltransdetail');
            await mysqlConn.query('TRUNCATE TABLE gltrans');
            await mysqlConn.query('TRUNCATE TABLE account');
            await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
        }

        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'ACCOUNT', mysqlTable: 'account', columns: ACC_COLUMNS, pk: 'ACCOUNTID', fbBatchSize, mysqlBatchSize });
        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'GLTRANS', mysqlTable: 'gltrans', columns: GL_COLUMNS, pk: 'GLTRANSID', fbBatchSize, mysqlBatchSize });
        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'GLTRANSDETAIL', mysqlTable: 'gltransdetail', columns: GLD_COLUMNS, pk: 'ITEMID', fbBatchSize, mysqlBatchSize });

    } catch (err) {
        log.error('❌ Error en migración contable', err);
    } finally {
        if (fbDb) fbDb.detach();
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) migrateAccountantTrans();
module.exports = migrateAccountantTrans;