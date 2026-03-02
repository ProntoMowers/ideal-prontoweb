require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');

const LOG_NAME = `migrateWorkOrders_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

// Configuración de columnas seguras (Sin BLOBs)
const WO_COLUMNS = [
    'WORKORDERID', 'CUSTOMERID', 'PRIORITY', 'TAGNUMBER', 'JOBEMPLOYEE', 'MFRID', 'PARTNUMBER',
    'PRODUCTSERIALNUMBER', 'PRODUCTDESCRIPTION', 'PURCHASEDATE', 'PICKUP', 'PICKUPDATE', 'DELIVER',
    'DELIVERDATE', 'MODELYEAR', 'METER', 'REFERENCE', 'ENTRYDATE', 'FAILDATE', 'INDATE', 'STARTDATE',
    'ESTIMATEDCOMPLETEDATE', 'COMPLETEDATE', 'OUTDATE', 'CLOSEDATE', 'FIRSTNOTIFYDATE', 'SECONDNOTIFYDATE',
    'CODEGROUPID', 'ENGINEMFRID', 'ENGINEMODELNUMBER', 'ENGINESERIALNUMBER', 'WARRANTYMONTHS',
    'LABORASONELINE', 'STOCKNUMBER'
];

const WOD_COLUMNS = [
    'ITEMID', 'WORKORDERID', 'CODEGROUPID', 'CODETYPE', 'JOBCODE', 'DESCRIPTION', 'SERVICEPRODUCTID',
    'SERVICEMFRID', 'HOURS', 'RATE', 'AMOUNT', 'TOTAL', 'JOBEMPLOYEE', 'WARRANTYCLAIMID', 'BILLED',
    'SERVICECATEGORY', 'SERVICESALESTAXCLASS', 'SETJOBITEMID', 'SETITEMID', 'ITEMIZE',
    'STOCKUNITLISTPRICE', 'LABORITEMID', 'WARRANTYCODE', 'WORKORDERJOBID', 'EXTRAISPERCENT',
    'EXTRAPERCENTOF', 'EXTRAPERCENTMAX', 'EXTRAITEMSTYPE', 'EXTRAPERCENT', 'ITEMPOSITION'
];

const WOH_COLUMNS = [
    'WORKORDERID', 'CUSTOMERID', 'PRIORITY', 'TAGNUMBER', 'JOBEMPLOYEE', 'MFRID', 'PARTNUMBER',
    'PRODUCTSERIALNUMBER', 'PRODUCTDESCRIPTION', 'PURCHASEDATE', 'PICKUP', 'PICKUPDATE', 'DELIVER',
    'DELIVERDATE', 'METER', 'MODELYEAR', 'REFERENCE', 'ENTRYDATE', 'FAILDATE', 'INDATE', 'STARTDATE',
    'ESTIMATEDCOMPLETEDATE', 'COMPLETEDATE', 'OUTDATE', 'CLOSEDATE', 'FIRSTNOTIFYDATE', 'SECONDNOTIFYDATE',
    'CODEGROUPID', 'ENGINEMFRID', 'ENGINEMODELNUMBER', 'ENGINESERIALNUMBER', 'SALESORDERTYPE', 'STOCKNUMBER'
];

const WOHD_COLUMNS = [...WOD_COLUMNS]; // Misma estructura que el detalle activo

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
}

async function migrateWorkOrders() {
    const startTime = Date.now();
    const fbBatchSize = parseInt(process.env.FB_BATCH_SIZE || '5000', 10);
    const mysqlBatchSize = parseInt(process.env.MYSQL_BATCH_SIZE || '1000', 10);
    const fullRefresh = (process.env.FULL_REFRESH_WORKORDERS || 'false').toLowerCase() === 'true';

    let fbDb, mysqlConn;

    try {
        fbDb = await getFirebirdConnection();
        mysqlConn = await getMySqlConnection();

        if (fullRefresh) {
            log.info('🧹 Limpiando tablas de Work Orders (Full Refresh)...');
            await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');
            await mysqlConn.query('TRUNCATE TABLE workorderdetail');
            await mysqlConn.query('TRUNCATE TABLE workorder');
            await mysqlConn.query('TRUNCATE TABLE workorderhistdetail');
            await mysqlConn.query('TRUNCATE TABLE workorderhist');
            await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
        }

        log.info('🚀 Iniciando migración de WORKORDERS...');
        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'WORKORDER', mysqlTable: 'workorder', columns: WO_COLUMNS, pk: 'WORKORDERID', fbBatchSize, mysqlBatchSize });
        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'WORKORDERDETAIL', mysqlTable: 'workorderdetail', columns: WOD_COLUMNS, pk: 'ITEMID', fbBatchSize, mysqlBatchSize });
        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'WORKORDERHIST', mysqlTable: 'workorderhist', columns: WOH_COLUMNS, pk: 'WORKORDERID', fbBatchSize, mysqlBatchSize });
        await runMigrationForTable(fbDb, mysqlConn, { fbTable: 'WORKORDERHISTDETAIL', mysqlTable: 'workorderhistdetail', columns: WOHD_COLUMNS, pk: 'ITEMID', fbBatchSize, mysqlBatchSize });

    } catch (err) {
        log.error('❌ Error en migración', err);
    } finally {
        if (fbDb) fbDb.detach();
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) migrateWorkOrders();
module.exports = migrateWorkOrders;