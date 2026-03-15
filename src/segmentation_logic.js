require('dotenv').config();

const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `segmentation_logic_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

const COMPANY_ZIP = (process.env.SEGMENTATION_COMPANY_ZIP || process.env.COMPANY_ZIP || '').trim();
const SEGMENTATION_BATCH_SIZE = Number(process.env.SEGMENTATION_BATCH_SIZE || 5000);
const SEGMENTATION_LOOKBACK_YEARS = Number(process.env.SEGMENTATION_LOOKBACK_YEARS || 3);
const SEGMENTATION_LOCK_WAIT_TIMEOUT = Number(process.env.SEGMENTATION_LOCK_WAIT_TIMEOUT || 300);
const INVOICE_ARTYPE_FILTER = "LOWER(TRIM(COALESCE(si.ARTYPE, ''))) = 'invoice'";

const SEGMENTATION_SETTING_DEFAULTS = {
  company_zip: COMPANY_ZIP,
  distance_enabled: true,
  excluded_customer_type: 'internet',
  lookback_years: SEGMENTATION_LOOKBACK_YEARS,
  invoice_window_30d_days: 30,
  invoice_window_90d_days: 90,
  invoice_window_6m_months: 6,
  invoice_window_12m_months: 12,
  invoice_window_24m_months: 24,
  engagement_new_total_invoices: 1,
  engagement_inactive_months: 12,
  engagement_active_min_invoices: 1,
  engagement_loyal_min_invoices_12m: 6,
  engagement_occasional_min_invoices_12m: 2,
  engagement_occasional_max_invoices_12m: 5,
  vip_total_spend_min_amount: 500,
  vip_invoices_min_count: 36,
  vip_category_window_months: 24,
  vip_product_categories: ['21Mower', 'RideMowr'],
  customer_potential_repuestos_min_invoices_12m: 1,
  customer_potential_repuestos_min_total_invoices: 2,
  warranty_1m_max_days: 30,
  warranty_3m_max_days: 90,
  warranty_6m_max_days: 180,
};

function normalizeArg(value) {
  return (value || '').toString().trim().toLowerCase();
}

function coercePositiveNumber(rawValue, fallbackValue, { min = 1, integer = true } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < min) return fallbackValue;
  return integer ? Math.floor(parsed) : parsed;
}

function coerceBoolean(rawValue, fallbackValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return fallbackValue;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'si', 's'].includes(normalized)) return true;
  if (['0', 'false', 'f', 'no', 'n'].includes(normalized)) return false;
  return fallbackValue;
}

function coerceStringList(rawValue, fallbackValue) {
  if (rawValue === null || rawValue === undefined) return fallbackValue;
  const values = String(rawValue)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallbackValue;
}

function coerceSettingValue(key, rawValue, fallbackValue) {
  if (Array.isArray(fallbackValue)) return coerceStringList(rawValue, fallbackValue);
  if (typeof fallbackValue === 'boolean') return coerceBoolean(rawValue, fallbackValue);
  if (typeof fallbackValue === 'number') {
    return coercePositiveNumber(rawValue, fallbackValue, {
      min: 0,
      integer: !String(rawValue).includes('.'),
    });
  }
  if (typeof fallbackValue === 'string') {
    const normalized = String(rawValue || '').trim();
    return normalized === '' ? fallbackValue : normalized;
  }
  return fallbackValue;
}

async function loadSegmentationSettings(conn) {
  const settings = { ...SEGMENTATION_SETTING_DEFAULTS };

  const hasSettingsTable = await tableExists(conn, 'segmentation_parameters');
  if (!hasSettingsTable) {
    log.warn('Tabla segmentation_parameters no encontrada. Se usaran los valores por defecto del script/.env.');
    return settings;
  }

  const [rows] = await conn.query(`
    SELECT param_key, param_value
    FROM segmentation_parameters
    WHERE is_active = 'Y'
  `);

  for (const row of rows) {
    const key = String(row.param_key || '').trim();
    if (!key || !(key in settings)) continue;
    settings[key] = coerceSettingValue(key, row.param_value, settings[key]);
  }

  log.info(
    'Parametros de segmentacion cargados: ' +
    JSON.stringify({
      lookback_years: settings.lookback_years,
      invoice_window_30d_days: settings.invoice_window_30d_days,
      invoice_window_90d_days: settings.invoice_window_90d_days,
      invoice_window_6m_months: settings.invoice_window_6m_months,
      invoice_window_12m_months: settings.invoice_window_12m_months,
      invoice_window_24m_months: settings.invoice_window_24m_months,
      vip_invoices_min_count: settings.vip_invoices_min_count,
      vip_total_spend_min_amount: settings.vip_total_spend_min_amount,
      vip_product_categories: settings.vip_product_categories,
      customer_potential_repuestos_min_invoices_12m: settings.customer_potential_repuestos_min_invoices_12m,
      customer_potential_repuestos_min_total_invoices: settings.customer_potential_repuestos_min_total_invoices,
      distance_enabled: settings.distance_enabled,
    })
  );

  return settings;
}

async function tableExists(conn, tableName) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function getTableColumns(conn, tableName) {
  const [rows] = await conn.execute(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [tableName]
  );
  return new Set(rows.map(r => (r.column_name || '').toLowerCase()));
}

function pickColumn(columnsSet, candidates) {
  for (const c of candidates) {
    if (columnsSet.has(c.toLowerCase())) return c;
  }
  return null;
}

async function buildCountryCodeExpression(conn) {
  const hasCountries = await tableExists(conn, 'countries');
  if (!hasCountries) {
    log.warn('Tabla countries no encontrada. countryCode se guardara como US.');
    return "'US'";
  }

  const columns = await getTableColumns(conn, 'countries');
  const codeCol = pickColumn(columns, ['COUNTRY_CODE', 'ISO2', 'COUNTRYCODE', 'CODE', 'ALPHA2']);
  const nameCol = pickColumn(columns, ['COUNTRY_NAME', 'NAME', 'COUNTRY', 'COUNTRYNAME']);

  if (!codeCol || !nameCol) {
    log.warn('No fue posible resolver columnas de countries. countryCode se guardara como US.');
    return "'US'";
  }

  log.info(`Usando columnas de countries: codeCol=${codeCol}, nameCol=${nameCol}`);

  return `COALESCE(
    (
      SELECT UPPER(LEFT(TRIM(cc.\`${codeCol}\`), 2))
      FROM countries cc
      WHERE LOWER(TRIM(cc.\`${nameCol}\`) COLLATE utf8mb4_general_ci)
            = LOWER(TRIM(c.COUNTRY) COLLATE utf8mb4_general_ci)
      LIMIT 1
    ),
    'US'
  )`;
}

async function buildDistanceExpression(conn) {
  if (!COMPANY_ZIP) {
    log.warn('SEGMENTATION_COMPANY_ZIP no definido en .env. distance_miles quedara en NULL.');
    return 'NULL';
  }

  const hasZipTable = await tableExists(conn, 'uszipcodes');
  if (!hasZipTable) {
    log.warn('Tabla uszipcodes no encontrada. distance_miles quedara en NULL.');
    return 'NULL';
  }

  const columns = await getTableColumns(conn, 'uszipcodes');
  const zipCol = pickColumn(columns, ['ZIP', 'ZIPCODE', 'ZIP_CODE']);
  const latCol = pickColumn(columns, ['LAT', 'LATITUDE']);
  const lngCol = pickColumn(columns, ['LNG', 'LONG', 'LONGITUDE', 'LON']);

  if (!zipCol || !latCol || !lngCol) {
    log.warn('Columnas de uszipcodes no resueltas. distance_miles quedara en NULL.');
    return 'NULL';
  }

  log.info(`Haversine: zip=${zipCol}, lat=${latCol}, lng=${lngCol}, company_zip=${COMPANY_ZIP}`);

  const companyZipEscaped = COMPANY_ZIP.replace(/'/g, "''");

  return `(
    SELECT ROUND(
      3959 * ACOS(
        LEAST(1, GREATEST(-1,
          COS(RADIANS(base.\`${latCol}\`)) * COS(RADIANS(cz.\`${latCol}\`))
          * COS(RADIANS(cz.\`${lngCol}\`) - RADIANS(base.\`${lngCol}\`))
          + SIN(RADIANS(base.\`${latCol}\`)) * SIN(RADIANS(cz.\`${latCol}\`))
        ))
      ), 2
    )
    FROM uszipcodes base
    JOIN uszipcodes cz ON 1 = 1
    WHERE LPAD(CAST(base.\`${zipCol}\` AS CHAR), 5, '0') = LPAD(LEFT('${companyZipEscaped}', 5), 5, '0')
      AND LPAD(CAST(cz.\`${zipCol}\` AS CHAR), 5, '0') = LPAD(LEFT(TRIM(SUBSTRING_INDEX(c.ZIP, '-', 1)), 5), 5, '0')
    LIMIT 1
  )`;
}

async function dropTempTables(conn) {
  const tables = ['tmp_seg_customers', 'tmp_seg_distance', 'tmp_seg_inv_stats', 'tmp_seg_main_brand', 'tmp_seg_activity', 'tmp_seg_warranty', 'tmp_seg_vip_products', 'tmp_seg_vip_cat', 'tmp_seg_batch'];
  for (const t of tables) {
    try { await conn.query(`DROP TEMPORARY TABLE IF EXISTS \`${t}\``); } catch (_) {}
  }
}

async function runSegmentationAll(conn) {
  const hasTargetTable = await tableExists(conn, 'customer_segmentation');
  if (!hasTargetTable) {
    throw new Error('La tabla customer_segmentation no existe. Ejecuta primero el SQL de creacion.');
  }

  const segmentationSettings = await loadSegmentationSettings(conn);
  const lookbackYears = segmentationSettings.lookback_years;
  const excludedCustomerType = String(segmentationSettings.excluded_customer_type || 'internet').toLowerCase();
  const distanceEnabled = Boolean(segmentationSettings.distance_enabled);
  const companyZip = String(segmentationSettings.company_zip || COMPANY_ZIP || '').trim();
  const invoiceWindow30dDays = segmentationSettings.invoice_window_30d_days;
  const invoiceWindow90dDays = segmentationSettings.invoice_window_90d_days;
  const invoiceWindow6mMonths = segmentationSettings.invoice_window_6m_months;
  const invoiceWindow12mMonths = segmentationSettings.invoice_window_12m_months;
  const invoiceWindow24mMonths = segmentationSettings.invoice_window_24m_months;
  const engagementNewTotalInvoices = segmentationSettings.engagement_new_total_invoices;
  const engagementInactiveMonths = segmentationSettings.engagement_inactive_months;
  const engagementActiveMinInvoices = segmentationSettings.engagement_active_min_invoices;
  const engagementLoyalMinInvoices12m = segmentationSettings.engagement_loyal_min_invoices_12m;
  const engagementOccasionalMinInvoices12m = segmentationSettings.engagement_occasional_min_invoices_12m;
  const engagementOccasionalMaxInvoices12m = segmentationSettings.engagement_occasional_max_invoices_12m;
  const vipTotalSpendMinAmount = segmentationSettings.vip_total_spend_min_amount;
  const vipInvoicesMinCount = segmentationSettings.vip_invoices_min_count;
  const vipCategoryWindowMonths = segmentationSettings.vip_category_window_months;
  const vipProductCategories = segmentationSettings.vip_product_categories;
  const vipProductCategoriesSql = vipProductCategories.map(value => conn.escape(value)).join(', ') || "''";
  const customerPotentialRepuestosMinInvoices12m = segmentationSettings.customer_potential_repuestos_min_invoices_12m;
  const customerPotentialRepuestosMinTotalInvoices = segmentationSettings.customer_potential_repuestos_min_total_invoices;
  const warranty1mMaxDays = segmentationSettings.warranty_1m_max_days;
  const warranty3mMaxDays = segmentationSettings.warranty_3m_max_days;
  const warranty6mMaxDays = segmentationSettings.warranty_6m_max_days;

  log.info('Limpiando customer_segmentation antes de reconstruir...');
  await conn.query('TRUNCATE TABLE customer_segmentation');

  const countryCodeExpr = await buildCountryCodeExpression(conn);

  await conn.query(`SET SESSION innodb_lock_wait_timeout = ${Math.max(30, SEGMENTATION_LOCK_WAIT_TIMEOUT)}`);
  await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await conn.query('SET SESSION group_concat_max_len = 65536');

  await dropTempTables(conn);

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_customers (
      CUSTOMERID VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
      PRIMARY KEY (CUSTOMERID)
    ) ENGINE=MEMORY
  `);

  await conn.execute(
    `INSERT INTO tmp_seg_customers (CUSTOMERID)
     SELECT c.CUSTOMERID
     FROM customer c
     WHERE c.LASTCHANGEDATE IS NOT NULL
       AND c.LASTCHANGEDATE >= (NOW() - INTERVAL ? YEAR)
       AND LOWER(TRIM(COALESCE(c.CUSTOMERTYPE, ''))) COLLATE utf8mb4_general_ci <> ?
       AND (
         NULLIF(TRIM(COALESCE(c.CELL, '')), '') IS NOT NULL
         OR NULLIF(TRIM(COALESCE(c.PHONE, '')), '') IS NOT NULL
         OR NULLIF(TRIM(COALESCE(c.EMAIL, '')), '') IS NOT NULL
       )`,
    [lookbackYears, excludedCustomerType]
  );

  const [[{ total: sourceCount }]] = await conn.query('SELECT COUNT(*) AS total FROM tmp_seg_customers');
  log.info(
    `[0/4] Clientes elegibles para esta corrida: ${sourceCount} ` +
    `(ultimos ${lookbackYears} anios, excluyendo ${excludedCustomerType})`
  );

  if (Number(sourceCount) === 0) {
    await dropTempTables(conn);
    return { sourceCount: 0, targetCount: 0, affectedRows: 0, processedCount: 0, batches: 0 };
  }

  // El CAST(c.ZIP AS UNSIGNED) es seguro incluso con ZIPs inválidos (ej. 'PANAM'):
  // MySQL los castea silenciosamente a 0, que no matchea ningún ZIP en uszipcodes
  // → el cliente recibe NULL en distance_miles vía LEFT JOIN (comportamiento correcto).
  // Una vez que migrateCustomers.js corra con normalizeZipValue, la cobertura mejorará.
  const hasDistanceFeature = distanceEnabled;
  if (hasDistanceFeature) {
    log.info('[0.5/4] Pre-computando distancia por cliente (solo ZIPs válidos)...');

    await conn.query(`
      CREATE TEMPORARY TABLE tmp_seg_distance (
        CUSTOMERID     VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        distance_miles DECIMAL(10,2),
        PRIMARY KEY (CUSTOMERID)
      )
    `);

    const companyZipNumeric = Number.parseInt(String(companyZip).trim().slice(0, 5), 10);
    if (Number.isFinite(companyZipNumeric)) {
      await conn.execute(
        `INSERT INTO tmp_seg_distance (CUSTOMERID, distance_miles)
         SELECT
           c.CUSTOMERID,
           ROUND(
             3959 * ACOS(
               LEAST(1, GREATEST(-1,
                 COS(RADIANS(base.LAT)) * COS(RADIANS(cz.LAT))
                 * COS(RADIANS(cz.LNG) - RADIANS(base.LNG))
                 + SIN(RADIANS(base.LAT)) * SIN(RADIANS(cz.LAT))
               ))
             ),
             2
           ) AS distance_miles
         FROM tmp_seg_customers sc
         JOIN customer c
           ON c.CUSTOMERID COLLATE utf8mb4_general_ci = sc.CUSTOMERID
         JOIN uszipcodes base ON base.ZIP = ?
         LEFT JOIN uszipcodes cz
           ON c.ZIP IS NOT NULL
           AND cz.ZIP = CAST(c.ZIP AS UNSIGNED)`,
        [companyZipNumeric]
      );

      const [[{ total: distCount }]] = await conn.query('SELECT COUNT(*) AS total FROM tmp_seg_distance');
      log.info(`[0.5/4] OK: ${distCount} clientes con distancia calculada. (${((Date.now() - (Date.now() - 1000)) / 1000).toFixed(1)}s)`);
    } else {
      log.warn('No se pudo parsear COMPANY_ZIP numerico. distance_miles quedara en NULL.');
    }
  }

  // ================================================================
  // FASE 1: Pre-computar agregaciones UNA SOLA VEZ (sin locks largos)
  // ================================================================

  const t1 = Date.now();
  log.info('[1/4] Pre-computando estadisticas de facturas (salesinvoice)...');

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_inv_stats (
      CUSTOMERID         VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      last_purchase_date DATETIME,
      total_spend        DECIMAL(15,2),
      total_spend_24m    DECIMAL(15,2),
      total_invoices     INT,
      inv_30d            INT,
      inv_90d            INT,
      inv_6m             INT,
      inv_12m            INT,
      inv_24m            INT,
      PRIMARY KEY (CUSTOMERID)
    )
  `);

  await conn.query(`
    INSERT INTO tmp_seg_inv_stats
    SELECT
      si.CUSTOMERID,
      MAX(si.TRANSDATE),
      ROUND(SUM(COALESCE(si.NETAMOUNT, 0)), 2),
      ROUND(SUM(CASE WHEN si.TRANSDATE >= (NOW() - INTERVAL ${invoiceWindow24mMonths} MONTH) THEN COALESCE(si.NETAMOUNT, 0) ELSE 0 END), 2),
      COUNT(*),
      SUM(CASE WHEN si.TRANSDATE >= (NOW() - INTERVAL ${invoiceWindow30dDays} DAY) THEN 1 ELSE 0 END),
      SUM(CASE WHEN si.TRANSDATE >= (NOW() - INTERVAL ${invoiceWindow90dDays} DAY) THEN 1 ELSE 0 END),
      SUM(CASE WHEN si.TRANSDATE >= (NOW() - INTERVAL ${invoiceWindow6mMonths} MONTH) THEN 1 ELSE 0 END),
      SUM(CASE WHEN si.TRANSDATE >= (NOW() - INTERVAL ${invoiceWindow12mMonths} MONTH) THEN 1 ELSE 0 END),
      SUM(CASE WHEN si.TRANSDATE >= (NOW() - INTERVAL ${invoiceWindow24mMonths} MONTH) THEN 1 ELSE 0 END)
    FROM tmp_seg_customers sc
    STRAIGHT_JOIN salesinvoice si ON si.CUSTOMERID = sc.CUSTOMERID
    WHERE ${INVOICE_ARTYPE_FILTER}
    GROUP BY si.CUSTOMERID
  `);

  const [[{ total: invCount }]] = await conn.query('SELECT COUNT(*) AS total FROM tmp_seg_inv_stats');
  log.info(`[1/4] OK: ${invCount} clientes con facturas. (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  const t2 = Date.now();
  log.info('[2/4] Pre-computando marca principal y tipo de actividad...');

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_main_brand (
      CUSTOMERID VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      main_brand VARCHAR(100),
      PRIMARY KEY (CUSTOMERID)
    )
  `);

  await conn.query(`
    INSERT INTO tmp_seg_main_brand
    SELECT customerid,
           SUBSTRING_INDEX(
             GROUP_CONCAT(COALESCE(br.brand_name, x.mfrid) ORDER BY total_net DESC SEPARATOR ','),
             ',',
             1
           ) AS main_brand
    FROM (
      SELECT
        si.CUSTOMERID AS customerid,
        TRIM(sid.MFRID) AS mfrid,
        SUM(COALESCE(sid.NETAMOUNT, 0)) AS total_net
      FROM tmp_seg_customers sc
      STRAIGHT_JOIN salesinvoice si ON si.CUSTOMERID = sc.CUSTOMERID
      JOIN salesinvoicedetail sid ON sid.ARTRANSID = si.ARTRANSID
      WHERE ${INVOICE_ARTYPE_FILTER}
        AND sid.MFRID IS NOT NULL
        AND TRIM(sid.MFRID) <> ''
        AND REPLACE(TRIM(sid.MFRID), '*', '') <> ''
      GROUP BY si.CUSTOMERID, TRIM(sid.MFRID)
    ) x
    LEFT JOIN (
      SELECT
        TRIM(b.mfrid) AS mfrid,
        MAX(
          CASE
            WHEN NULLIF(TRIM(b.nombre), '') IS NULL THEN NULL
            WHEN REPLACE(TRIM(b.nombre), '*', '') = '' THEN NULL
            ELSE TRIM(b.nombre)
          END
        ) AS brand_name
      FROM brands b
      WHERE b.mfrid IS NOT NULL
        AND TRIM(b.mfrid) <> ''
        AND REPLACE(TRIM(b.mfrid), '*', '') <> ''
      GROUP BY TRIM(b.mfrid)
    ) br ON br.mfrid COLLATE utf8mb4_general_ci = x.mfrid COLLATE utf8mb4_general_ci
    GROUP BY customerid
  `);

  const [[{ total: brandCount }]] = await conn.query('SELECT COUNT(*) AS total FROM tmp_seg_main_brand');
  log.info(`[2a/4] OK: ${brandCount} marcas principales. (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_activity (
      CUSTOMERID    VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      activity_type VARCHAR(50),
      PRIMARY KEY (CUSTOMERID)
    )
  `);

  await conn.query(`
    INSERT INTO tmp_seg_activity (CUSTOMERID, activity_type)
    SELECT
      si.CUSTOMERID,
      CASE
        WHEN SUM(
          CASE
            WHEN (
              COALESCE(sid.WORKORDERJOBID, 0) = 0
              OR (
                COALESCE(sid.WORKORDERJOBID, 0) <> 0
                AND UPPER(TRIM(COALESCE(sid.CATEGORY, ''))) = 'REBATE'
              )
              OR UPPER(TRIM(COALESCE(sid.PRODUCTTYPE, ''))) = 'S'
            ) THEN 0
            ELSE 1
          END
        ) > 0 THEN 'WORKSHOP'
        ELSE 'STORE'
      END AS activity_type
    FROM tmp_seg_customers sc
    STRAIGHT_JOIN salesinvoice si ON si.CUSTOMERID = sc.CUSTOMERID
    JOIN salesinvoicedetail sid ON sid.ARTRANSID = si.ARTRANSID
    WHERE ${INVOICE_ARTYPE_FILTER}
    GROUP BY si.CUSTOMERID
  `);

  const [[{ total: actCount }]] = await conn.query('SELECT COUNT(*) AS total FROM tmp_seg_activity');
  log.info(`[2b/4] OK: ${actCount} tipos de actividad. (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_warranty (
      CUSTOMERID VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      equipment_under_warranty VARCHAR(50),
      PRIMARY KEY (CUSTOMERID)
    )
  `);

  await conn.query(`
    INSERT INTO tmp_seg_warranty (CUSTOMERID, equipment_under_warranty)
    SELECT
      x.CUSTOMERID,
      CASE
        WHEN x.min_days_to_exp <= ${warranty1mMaxDays} THEN 'Garantia vence 1 mes'
        WHEN x.min_days_to_exp <= ${warranty3mMaxDays} THEN 'Garantia vence 3 meses'
        WHEN x.min_days_to_exp <= ${warranty6mMaxDays} THEN 'Garantia vence 6 meses'
        ELSE NULL
      END AS equipment_under_warranty
    FROM (
      SELECT
        su.CUSTOMERID,
        MIN(DATEDIFF(DATE(su.WARRANTYEXPDATE), CURDATE())) AS min_days_to_exp
      FROM stockunit su
      JOIN tmp_seg_customers sc
        ON sc.CUSTOMERID COLLATE utf8mb4_general_ci = su.CUSTOMERID COLLATE utf8mb4_general_ci
      WHERE su.CUSTOMERID IS NOT NULL
        AND TRIM(su.CUSTOMERID) <> ''
        AND su.WARRANTYEXPDATE IS NOT NULL
        AND DATE(su.WARRANTYEXPDATE) >= CURDATE()
      GROUP BY su.CUSTOMERID
    ) x
    WHERE x.min_days_to_exp <= ${warranty6mMaxDays}
  `);

  const [[{ total: warrantyCount }]] = await conn.query('SELECT COUNT(*) AS total FROM tmp_seg_warranty');
  log.info(`[2c/4] OK: ${warrantyCount} clientes con garantia proxima. (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

  const t3 = Date.now();
  log.info('[3/4] Pre-computando clientes VIP por categoria de producto...');

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_vip_products (
      MFRID      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
      PARTNUMBER VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
      PRIMARY KEY (MFRID, PARTNUMBER)
    ) ENGINE=MEMORY
  `);

  await conn.query(`
    INSERT IGNORE INTO tmp_seg_vip_products (MFRID, PARTNUMBER)
    SELECT p.MFRID COLLATE utf8mb4_general_ci,
           p.PARTNUMBER COLLATE utf8mb4_general_ci
    FROM product p
    WHERE p.CATEGORY IN (${vipProductCategoriesSql})
  `);

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_vip_cat (
      CUSTOMERID VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      PRIMARY KEY (CUSTOMERID)
    )
  `);

  await conn.query(`
    INSERT IGNORE INTO tmp_seg_vip_cat (CUSTOMERID)
    SELECT DISTINCT si.CUSTOMERID
    FROM tmp_seg_customers sc
    STRAIGHT_JOIN salesinvoice si ON si.CUSTOMERID = sc.CUSTOMERID
    JOIN salesinvoicedetail sid ON sid.ARTRANSID = si.ARTRANSID
    JOIN tmp_seg_vip_products vp
      ON vp.MFRID = sid.MFRID
     AND vp.PARTNUMBER = sid.PARTNUMBER
    WHERE ${INVOICE_ARTYPE_FILTER}
      AND si.TRANSDATE >= (NOW() - INTERVAL ${vipCategoryWindowMonths} MONTH)
  `);

  const [[{ total: vipCatCount }]] = await conn.query('SELECT COUNT(*) AS total FROM tmp_seg_vip_cat');
  log.info(`[3/4] OK: ${vipCatCount} clientes VIP por categoria. (${((Date.now() - t3) / 1000).toFixed(1)}s)`);

  // ================================================================
  // FASE 2: Insert en lotes - solo JOINs indexados contra temp tables
  // ================================================================

  log.info(
    `[4/4] Insert en lotes. Clientes a procesar: ${sourceCount} ` +
    `(ultimos ${lookbackYears} anios). Batch=${SEGMENTATION_BATCH_SIZE}`
  );

  await conn.query(`
    CREATE TEMPORARY TABLE tmp_seg_batch (
      CUSTOMERID VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      PRIMARY KEY (CUSTOMERID)
    ) ENGINE=MEMORY
  `);

  const distanceSelectExpr = hasDistanceFeature ? 'dist.distance_miles' : 'NULL';
  const distanceRangeSelectExpr = hasDistanceFeature
    ? `CASE
         WHEN dist.distance_miles IS NULL THEN NULL
         WHEN dist.distance_miles < 6 THEN '0 – 6 miles'
         WHEN dist.distance_miles < 15 THEN '6 – 15 miles'
         WHEN dist.distance_miles < 30 THEN '15 – 30 miles'
         WHEN dist.distance_miles < 50 THEN '30 – 50 miles'
         WHEN dist.distance_miles <= 75 THEN '50 – 75 miles'
         ELSE 'More than 75 miles'
       END`
    : 'NULL';
  const distanceJoinSql = hasDistanceFeature
    ? 'LEFT JOIN tmp_seg_distance dist ON dist.CUSTOMERID = b.CUSTOMERID'
    : '';

  const insertSql = `
    INSERT INTO customer_segmentation (
      ideal_id, name, firstname, lastname, phone, email, language, countryCode,
      category, last_purchase_date, total_spend, city, is_organization, zip_code,
      date_of_birth, concent_sms, allow_email, allow_whatsapp, notes,
      sales_person, employes_qty, altphone, distance_miles, distance_range,
      total_invoices, invoices_last_30_days, invoices_last_90_days,
      invoices_last_6_months, invoices_last_12_months, invoices_last_24_months,
      customer_engagement_status, main_brand, activity_type,
      equipment_under_warranty, customer_potential
    )
    SELECT
      c.CUSTOMERID,
      c.NAME,
      c.FIRSTNAME,
      c.LASTNAME,
      CASE WHEN NULLIF(TRIM(c.CELL),'') IS NOT NULL THEN NULLIF(TRIM(c.CELL),'') ELSE NULLIF(TRIM(c.PHONE),'') END,
      c.EMAIL,
      CASE WHEN LOWER(TRIM(COALESCE(c.FAX,''))) IN ('es','spa','spanish') THEN 'es' ELSE 'en' END,
      ${countryCodeExpr},
      c.CUSTOMERTYPE,
      ia.last_purchase_date,
      ia.total_spend,
      c.CITY,
      c.ISORGANIZATION,
      c.ZIP,
      DATE(c.DATEOFBIRTH),
      c.ALLOWTEXTS,
      c.ALLOWEMAIL,
      'F',
      '',
      c.SALESREP,
      c.FAXEXT,
      CASE
        WHEN NULLIF(TRIM(c.CELL),'') IS NOT NULL
          THEN COALESCE(NULLIF(TRIM(c.ALTPHONE),''), NULLIF(TRIM(c.PHONE),''))
        ELSE NULLIF(TRIM(c.ALTPHONE),'')
      END,
      ${distanceSelectExpr},
      ${distanceRangeSelectExpr},
      COALESCE(ia.total_invoices, 0),
      COALESCE(ia.inv_30d, 0),
      COALESCE(ia.inv_90d, 0),
      COALESCE(ia.inv_6m, 0),
      COALESCE(ia.inv_12m, 0),
      COALESCE(ia.inv_24m, 0),
      CASE
        WHEN COALESCE(ia.total_invoices, 0) = ${engagementNewTotalInvoices} THEN 'new'
        WHEN COALESCE(ia.inv_24m, 0) = 0 THEN 'churned'
        WHEN COALESCE(ia.inv_12m, 0) = 0 
             AND ia.last_purchase_date IS NOT NULL
             AND ia.last_purchase_date < (NOW() - INTERVAL ${engagementInactiveMonths} MONTH) THEN 'inactive'
        WHEN COALESCE(ia.inv_90d, 0) >= ${engagementActiveMinInvoices} THEN 'active'
        WHEN COALESCE(ia.inv_12m, 0) >= ${engagementLoyalMinInvoices12m} THEN 'loyal'
        WHEN COALESCE(ia.inv_12m, 0) BETWEEN ${engagementOccasionalMinInvoices12m} AND ${engagementOccasionalMaxInvoices12m} THEN 'occasional'
        ELSE 'inactive'
      END,
      mb.main_brand,
      act.activity_type,
      w.equipment_under_warranty,
      CASE
        WHEN vc.CUSTOMERID IS NOT NULL
          OR COALESCE(ia.total_spend_24m,0) > ${vipTotalSpendMinAmount}
          OR COALESCE(ia.inv_12m,0) > ${vipInvoicesMinCount} THEN 'VIP'
        WHEN COALESCE(ia.inv_12m,0) >= ${customerPotentialRepuestosMinInvoices12m}
         AND COALESCE(ia.total_invoices,0) >= ${customerPotentialRepuestosMinTotalInvoices} THEN 'Repuestos'
        ELSE NULL
      END
    FROM tmp_seg_batch b
    JOIN customer c ON c.CUSTOMERID = b.CUSTOMERID
    ${distanceJoinSql}
    LEFT JOIN tmp_seg_inv_stats    ia  ON ia.CUSTOMERID  = b.CUSTOMERID
    LEFT JOIN tmp_seg_main_brand   mb  ON mb.CUSTOMERID  = b.CUSTOMERID
    LEFT JOIN tmp_seg_activity     act ON act.CUSTOMERID = b.CUSTOMERID
    LEFT JOIN tmp_seg_warranty     w   ON w.CUSTOMERID   = b.CUSTOMERID
    LEFT JOIN tmp_seg_vip_cat      vc  ON vc.CUSTOMERID  = b.CUSTOMERID
  `;

  let lastCustomerId = '';
  let processedCount = 0;
  let totalAffectedRows = 0;
  let batchNumber = 0;
  const loopStart = Date.now();

  while (true) {
    await conn.query('TRUNCATE TABLE tmp_seg_batch');

    await conn.execute(
      `INSERT INTO tmp_seg_batch (CUSTOMERID)
       SELECT sc.CUSTOMERID FROM tmp_seg_customers sc
       WHERE sc.CUSTOMERID > ?
       ORDER BY sc.CUSTOMERID LIMIT ?`,
      [lastCustomerId, SEGMENTATION_BATCH_SIZE]
    );

    const [[batchMeta]] = await conn.query(
      'SELECT COUNT(*) AS batch_count, MAX(CUSTOMERID) AS max_id FROM tmp_seg_batch'
    );

    const batchCount = Number(batchMeta.batch_count || 0);
    if (batchCount === 0) break;

    batchNumber += 1;
    const [result] = await conn.query(insertSql);
    totalAffectedRows += Number(result.affectedRows || 0);
    processedCount += batchCount;
    lastCustomerId = batchMeta.max_id;

    const elapsedSec = (Date.now() - loopStart) / 1000;
    const pct = ((processedCount / sourceCount) * 100).toFixed(2);
    const rps = processedCount > 0 ? (processedCount / elapsedSec) : 0;
    const etaSec = rps > 0 ? Math.round((Number(sourceCount) - processedCount) / rps) : 0;

    log.info(
      `[Lote ${batchNumber}] ${processedCount}/${sourceCount} (${pct}%) | ` +
      `batch=${batchCount} | affected=${result.affectedRows} | ETA~${etaSec}s`
    );
  }

  await dropTempTables(conn);

  const [[{ total: targetCount }]] = await conn.execute('SELECT COUNT(*) AS total FROM customer_segmentation');
  log.info(`Total en customer_segmentation: ${targetCount}`);

  return {
    sourceCount: Number(sourceCount),
    targetCount:  Number(targetCount),
    affectedRows: totalAffectedRows,
    processedCount,
    batches: batchNumber,
  };
}

async function main() {
  const mode = normalizeArg(process.argv[2]);
  const startTime = Date.now();

  if (mode !== 'all') {
    log.error('Uso invalido. Ejecuta: node src/segmentation_logic.js all');
    process.exit(1);
  }

  let conn;

  try {
    log.info('='.repeat(70));
    log.info('Inicio de segmentacion de clientes');
    log.info(`Modo: ${mode}`);
    log.info('='.repeat(70));

    conn = await getMySqlConnection();
    const summary = await runSegmentationAll(conn);

    log.info('Segmentacion finalizada correctamente.');
    log.info(`Clientes origen:  ${summary.sourceCount}`);
    log.info(`Procesados:       ${summary.processedCount}`);
    log.info(`Total lotes:      ${summary.batches}`);
    log.info(`Total destino:    ${summary.targetCount}`);
    log.info(`Affected rows:    ${summary.affectedRows}`);
  } catch (error) {
    log.error('Error en segmentacion de clientes', error);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info(`Duracion total: ${durationSec}s`);
    log.info('='.repeat(70));
  }
}

if (require.main === module) {
  main();
}
