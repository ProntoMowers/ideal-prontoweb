require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateProductStock_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

const COLUMNS = [
    'MFRID', 'PARTNUMBER', 'LOCATIONID', 'ORDERCODE', 'BINLOCATION',
    'STOCKLEVEL1', 'STOCKLEVEL2', 'STOCKLEVEL3', 'STOCKLEVEL4',
    'COMPOSITEKEY', 'LASTCOUNTDATE', 'LASTCOUNTUSERID',
    'BINLOCATION2', 'BINLOCATION3', 'BINLOCATION4'
];

function normalizeFbValue(val) {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val;
    if (Buffer.isBuffer(val)) return val;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') return val;
    return null;
}

async function migrateProductStock() {
    const startTime = Date.now();
    const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
    const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
    // Agrega esta variable a tu .env si deseas limpieza total: FULL_REFRESH_PRODUCTSTOCK=true
    const fullRefresh = (process.env.FULL_REFRESH_PRODUCTSTOCK || 'false').toLowerCase() === 'true';

    let fbDb, mysqlConn;

    try {
        fbDb = await getFirebirdConnection();
        mysqlConn = await getMySqlConnection();

        if (fullRefresh) {
            log.info('🧹 Limpiando tabla productstock (Full Refresh)...');
            await mysqlConn.query('TRUNCATE TABLE productstock');
        }

        const colList = COLUMNS.map(c => `\`${c}\``).join(', ');
        const updateAssignments = COLUMNS
            .filter(c => !['MFRID', 'PARTNUMBER', 'LOCATIONID'].includes(c))
            .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
            .join(', ');

        const sql = `INSERT INTO productstock (${colList}) VALUES ? ON DUPLICATE KEY UPDATE ${updateAssignments}`;

        let offset = 0;
        let totalProcessed = 0;

        while (true) {
            log.info(`📥 Leyendo PRODUCTSTOCK desde Firebird (Rows ${offset + 1} a ${offset + fbBatchSize})...`);
            
            // Nota: Se ordena por la PK compuesta para consistencia en la paginación
            const rows = await fbQuery(fbDb, 
                `SELECT * FROM PRODUCTSTOCK ORDER BY MFRID, PARTNUMBER, LOCATIONID ROWS ? TO ?`, 
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
            log.info(`✅ Procesados acumulados: ${totalProcessed}`);
        }

        log.info(`🎉 Migración de PRODUCTSTOCK finalizada. Total: ${totalProcessed}`);

    } catch (err) {
        log.error('❌ Error migrando PRODUCTSTOCK', err);
    } finally {
        if (fbDb) fbDb.detach();
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) migrateProductStock();
module.exports = migrateProductStock;