require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateSalesOrderCancel_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

const COLUMNS = [
    'SALESORDERID', 'ORDERDATE', 'CANCELDATE', 'CUSTOMERID', 'SALESREP',
    'LOCATIONID', 'SALESORDERTYPE', 'REFERENCE', 'ORIGINUSERID', 
    'ACTIVEUSERID', 'ORIGINCOMPUTERNAME'
];

function normalizeFbValue(val) {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') return val;
    return null;
}

async function migrateSalesOrderCancel() {
    const startTime = Date.now();
    const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
    const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
    const fullRefresh = (process.env.FULL_REFRESH_SALESORDERCANCEL || 'true').toLowerCase() === 'true';

    let fbDb, mysqlConn;

    try {
        fbDb = await getFirebirdConnection();
        mysqlConn = await getMySqlConnection();

        if (fullRefresh) {
            log.info('🧹 Limpiando tabla salesordercancel (Full Refresh)...');
            await mysqlConn.query('TRUNCATE TABLE salesordercancel');
        }

        const colList = COLUMNS.map(c => `\`${c}\``).join(', ');
        const updateAssignments = COLUMNS
            .filter(c => c !== 'SALESORDERID')
            .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
            .join(', ');

        const sql = `INSERT INTO salesordercancel (${colList}) VALUES ? ON DUPLICATE KEY UPDATE ${updateAssignments}`;

        let offset = 0;
        let totalProcessed = 0;

        while (true) {
            const rows = await fbQuery(fbDb, 
                `SELECT * FROM SALESORDERCANCEL ORDER BY SALESORDERID ROWS ? TO ?`, 
                [offset + 1, offset + fbBatchSize]
            );

            if (!rows || rows.length === 0) break;

            for (let i = 0; i < rows.length; i += mysqlBatchSize) {
                const chunk = rows.slice(i, i + mysqlBatchSize);
                const values = chunk.map(row => COLUMNS.map(col => normalizeFbValue(row[col])));
                await mysqlConn.query(sql, [values]);
                totalProcessed += values.length;
            }

            offset += fbBatchSize;
            log.info(`✅ [SALESORDERCANCEL] Procesados acumulados: ${totalProcessed}`);
        }

        log.info(`🎉 Migración finalizada. Total: ${totalProcessed}`);

    } catch (err) {
        log.error('❌ Error migrando SALESORDERCANCEL', err);
    } finally {
        if (fbDb) fbDb.detach();
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) migrateSalesOrderCancel();
module.exports = migrateSalesOrderCancel;