// src/updateKitsPricesBigCommerce.js
/**
 * Actualiza precios de kits en BigCommerce a partir de:
 *  - MySQL (prontoweb.kits_master / kits_details / brandsandstores / stores)
 *  - Firebird (IDEAL: PRODUCT, PRODUCTLOCATION)
 *  - MongoDB (Prontoweb.Products) para obtener ID BigCommerce, SKU y BRAND_ID
 *
 * Uso:
 *   node src/updateKitsPricesBigCommerce.js --storeId=3 --kitId=79837
 *   node src/updateKitsPricesBigCommerce.js --storeId=3              (todos los kits de esa store)
 *   node src/updateKitsPricesBigCommerce.js --storeId=all            (todas las stores con kits activos)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { getMySqlConnection, getFirebirdConnection, fbQuery } = require('../providers/dbConnections');
const createLogger = require('../helpers/logger');

const todayStr = new Date().toISOString().slice(0, 10);
const LOG_NAME = `updateKitsPricesBigCommerce_${todayStr}.log`;
const log = createLogger(LOG_NAME);

// CSV para componentes sin costo
const MISSING_COST_CSV_NAME = `kits_missing_cost_${todayStr}.csv`;
const MISSING_COST_CSV_PATH = path.join(__dirname, '..', 'logs', MISSING_COST_CSV_NAME);

// ========================= CACHES EN MEMORIA =========================

// Cache para INVENTARIO IDEAL: clave `${mfrid}||${partnumber}` → onhandQty
const idealStockCache = new Map();

// Cache para COSTOS IDEAL: clave `${mfrid}||${partnumber}` → { current, standard }
const idealCostCache = new Map();

// Cache para productos Mongo por SKU: clave `${storeId}||${sku}` → doc Mongo
const mongoProductBySkuCache = new Map();

// ========================= UTILIDADES CSV =========================

function ensureMissingCostCsvHeader() {
  if (!fs.existsSync(MISSING_COST_CSV_PATH)) {
    const header = 'storeid,store_description,brand,sku,brand_hijo,sku_hijo\n';
    fs.writeFileSync(MISSING_COST_CSV_PATH, header, 'utf8');
  }
}

function appendMissingCostRow({
  storeId,
  storeDescription,
  brand,
  sku,
  brandHijo,
  skuHijo,
}) {
  try {
    ensureMissingCostCsvHeader();
    const esc = (val) =>
      String(val == null ? '' : val).replace(/"/g, '""');
    const row =
      `"${esc(storeId)}","${esc(storeDescription)}","${esc(
        brand
      )}","${esc(sku)}","${esc(brandHijo)}","${esc(skuHijo)}"\n`;
    fs.appendFileSync(MISSING_COST_CSV_PATH, row, 'utf8');
  } catch (e) {
    log.warn('⚠ Error al escribir CSV de costos faltantes', e);
  }
}

// ========================= AUXILIARES =========================

// Lee parámetros de línea de comandos
function parseArgs() {
  const args = process.argv.slice(2);
  let storeId = null;
  let kitId = null;

  for (const arg of args) {
    if (arg.startsWith('--storeId=')) {
      storeId = arg.split('=')[1];
    } else if (arg.startsWith('--kitId=')) {
      kitId = arg.split('=')[1];
    }
  }

  return { storeId, kitId };
}

// Obtiene credenciales de BigCommerce para una store + descripción
async function getBigCommerceClient(mysqlConn, storeId) {
  // usamos columna id como en tus otros scripts
  const [rows] = await mysqlConn.query(
    'SELECT STOREHASH, ACCESSTOKEN, DESCRIPTION FROM stores WHERE id = ? LIMIT 1',
    [storeId]
  );

  if (!rows || rows.length === 0) {
    throw new Error(
      `No se encontraron credenciales de BigCommerce en tabla stores para id=${storeId}`
    );
  }

  const { STOREHASH, ACCESSTOKEN, DESCRIPTION } = rows[0];

  if (!STOREHASH || !ACCESSTOKEN) {
    throw new Error(
      `Credenciales incompletas para id=${storeId} (STOREHASH/ACCESSTOKEN vacíos)`
    );
  }

  const bcClient = axios.create({
    baseURL: `https://api.bigcommerce.com/stores/${STOREHASH}/v3`,
    timeout: 30000,
    headers: {
      'X-Auth-Token': ACCESSTOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  log.info(
    `💾 Credenciales BigCommerce cargadas para store id=${storeId}. STOREHASH=${STOREHASH}`
  );
  return { bcClient, storeDescription: DESCRIPTION || '' };
}

// Conexión Mongo solo para este script
async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://10.1.10.65:27017';
  const client = new MongoClient(uri, { connectTimeoutMS: 30000 });
  await client.connect();
  log.info(`✅ Conectado a MongoDB: ${uri}`);
  const db = client.db('Prontoweb');
  const productsCol = db.collection('Products');
  log.info('✅ Conectado a MongoDB y colección Products lista.');
  return { client, db, productsCol };
}

// Busca en Mongo el producto (colección Products: ID = product_id BC)
async function getMongoProduct(productsCol, storeId, kitId) {
  const product = await productsCol.findOne({
    STOREID: Number(storeId),
    ID: Number(kitId),
  });
  return product || null;
}

// Obtiene MFRID de IDEAL desde brandsandstores (MySQL)
async function getMfrIdFromBrand(mysqlConn, storeId, brandId) {
  const [rows] = await mysqlConn.query(
    'SELECT mfrid FROM brandsandstores WHERE storeid = ? AND brand_id = ? LIMIT 1',
    [storeId, brandId]
  );
  if (!rows || rows.length === 0) return null;
  return rows[0].mfrid;
}

// Obtiene fila de kits_master
async function getKitMaster(mysqlConn, storeId, sku) {
  const [rows] = await mysqlConn.query(
    'SELECT * FROM kits_master WHERE store_id = ? AND sku = ? LIMIT 1',
    [storeId, sku]
  );
  return rows.length ? rows[0] : null;
}

// Obtiene componentes del kit en kits_details
async function getKitComponents(mysqlConn, kitMasterId) {
  const [rows] = await mysqlConn.query(
    'SELECT * FROM kits_details WHERE id_master = ?',
    [kitMasterId]
  );
  return rows;
}

// Obtiene cantidad en mano en IDEAL (PRODUCTLOCATION) con cache
async function getOnhandQty(fbDb, mfrid, partnumber) {
  const key = `${mfrid}||${partnumber}`;
  if (idealStockCache.has(key)) {
    return idealStockCache.get(key);
  }

  const rows = await fbQuery(
    fbDb,
    `
      SELECT SUM(ONHANDAVAILABLEQUANTITY) AS QTY
      FROM PRODUCTLOCATION
      WHERE MFRID = ? AND PARTNUMBER = ? AND LOCATIONID = 4
    `,
    [mfrid, partnumber]
  );

  let qty = 0;
  if (rows && rows.length && rows[0].QTY != null) {
    qty = Number(rows[0].QTY) || 0;
  }
  idealStockCache.set(key, qty);
  return qty;
}

// Obtiene costos de IDEAL (PRODUCT) con cache
async function getIdealCosts(fbDb, mfrid, partnumber) {
  const key = `${mfrid}||${partnumber}`;
  if (idealCostCache.has(key)) {
    return idealCostCache.get(key);
  }

  const rows = await fbQuery(
    fbDb,
    `
      SELECT CURRENTCOST, STANDARDCOST
      FROM PRODUCT
      WHERE MFRID = ? AND PARTNUMBER = ?
    `,
    [mfrid, partnumber]
  );

  let result = { current: 0, standard: 0 };
  if (rows && rows.length) {
    result = {
      current: Number(rows[0].CURRENTCOST) || 0,
      standard: Number(rows[0].STANDARDCOST) || 0,
    };
  }

  idealCostCache.set(key, result);
  return result;
}

/**
 * Calcula costo base del kit sumando componentes.
 *
 * Reglas de costo por componente:
 *  - Se consulta PRODUCTLOCATION. Si onhandQty > 0:
 *      - se intenta usar CURRENTCOST; si es 0, se intenta STANDARDCOST.
 *  - Si onhandQty == 0:
 *      - se intenta usar STANDARDCOST; si es 0, se intenta CURRENTCOST.
 *  - Si ambos (CURRENTCOST y STANDARDCOST) son 0 ⇒ componente sin costo válido:
 *      - se registra en CSV
 *      - el kit se marca como inválido (no se debe actualizar).
 */
async function calculateBaseCostForKit(
  mysqlConn,
  fbDb,
  kitMaster,
  mfridIdeal,
  {
    storeId,
    storeDescription,
    kitBrand,
    kitSku,
  }
) {
  const kitId = kitMaster.id;
  log.info(
    `🔎 Buscando componentes para kit id_master=${kitId}, sku='${kitMaster.sku}', mfrid IDEAL='${mfridIdeal}'`
  );

  const components = await getKitComponents(mysqlConn, kitId);
  if (!components.length) {
    log.warn(`⚠ No se encontraron componentes en kits_details para id_master=${kitId}`);
    return { baseCost: 0, componentsCount: 0, missingCost: false };
  }

  log.info(
    `📦 ${components.length} componentes encontrados en kits_details para id_master=${kitId}`
  );

  let baseCost = 0;
  let missingCost = false;

  for (const comp of components) {
    const compMfrid = comp.brand || mfridIdeal;
    const compSku = comp.sku_son;
    const qty = Number(comp.sku_son_quantity || 0);

    if (!compMfrid || !compSku || !qty) {
      log.warn(
        `⚠ Componente inválido en kits_details id=${comp.id}: mfrid='${compMfrid}', sku_son='${compSku}', qty=${qty}`
      );
      continue;
    }

    const onhandQty = await getOnhandQty(fbDb, compMfrid, compSku);
    const { current, standard } = await getIdealCosts(fbDb, compMfrid, compSku);

    let unitCost = 0;

    if (onhandQty > 0) {
      // Tiene inventario: preferimos CURRENTCOST; si es 0 probamos STANDARDCOST
      if (current > 0) {
        unitCost = current;
      } else if (standard > 0) {
        unitCost = standard;
      }
    } else {
      // No tiene inventario: preferimos STANDARDCOST; si es 0 probamos CURRENTCOST
      if (standard > 0) {
        unitCost = standard;
      } else if (current > 0) {
        unitCost = current;
      }
    }

    if (unitCost <= 0) {
      // Ambos costos 0 o inexistentes ⇒ componente sin costo válido.
      log.warn(
        `⚠ Sin costos válidos para componente mfrid='${compMfrid}', partnumber='${compSku}' (current=${current}, standard=${standard})`
      );

      appendMissingCostRow({
        storeId,
        storeDescription,
        brand: kitBrand,
        sku: kitSku,
        brandHijo: compMfrid,
        skuHijo: compSku,
      });

      missingCost = true;
      break; // no seguimos sumando; el kit queda inválido
    }

    const subtotal = unitCost * qty;
    baseCost += subtotal;

    log.info(
      `🔹 Componente mfrid='${compMfrid}', partnumber='${compSku}', qty=${qty}, unitCost=${unitCost.toFixed(
        2
      )}, subtotal=${subtotal.toFixed(2)}`
    );
  }

  if (missingCost) {
    return {
      baseCost: 0,
      componentsCount: components.length,
      missingCost: true,
    };
  }

  return {
    baseCost,
    componentsCount: components.length,
    missingCost: false,
  };
}

// Calcula nuevos precios a partir de costo base + márgenes
function calculatePrices(baseCost, defaultPriceMargin, msrpMargin) {
  const cost = Number(baseCost) || 0;
  const defMargin = Number(defaultPriceMargin) || 0;
  const msrp = Number(msrpMargin) || 0;

  const price = cost + (cost * defMargin) / 100;
  const retailPrice = cost + (cost * msrp) / 100;

  return {
    cost,
    price: Number(price.toFixed(2)),
    retailPrice: Number(retailPrice.toFixed(2)),
  };
}

// Actualiza producto en BigCommerce
async function updateBigCommerceProduct(bcClient, productId, price, retailPrice, cost) {
  try {
    const payload = {
      price,
      retail_price: retailPrice,
      cost_price: cost,
    };

    const resp = await bcClient.put(`/catalog/products/${productId}`, payload);
    log.info(
      `🛒 BigCommerce actualizado para producto ${productId}. Status=${resp.status} ${resp.statusText}`
    );
  } catch (err) {
    if (err.response) {
      log.error(
        `❌ Error actualizando producto ${productId} en BigCommerce. Status=${err.response.status}`,
        err.response.data
      );
    } else {
      log.error(
        `❌ Error actualizando producto ${productId} en BigCommerce`,
        err.message || err
      );
    }
    throw err;
  }
}

// Actualiza precios en MongoDB
async function updateMongoProductPrices(
  productsCol,
  storeId,
  productId,
  { cost, price, retailPrice }
) {
  const filter = { STOREID: Number(storeId), ID: Number(productId) };
  const update = {
    $set: {
      COST_PRICE: cost,
      PRICE: price,
      RETAIL_PRICE: retailPrice,
      updatedAt: new Date(),
    },
  };

  const res = await productsCol.updateOne(filter, update);
  log.info(
    `🍃 MongoDB actualizado para STOREID=${storeId}, ID=${productId}. matched=${res.matchedCount}, modified=${res.modifiedCount}`
  );
}

// ========================= MAIN =========================

async function main() {
  const { storeId, kitId } = parseArgs();

  if (!storeId) {
    console.error('Debe indicar --storeId=ID o --storeId=all');
    process.exit(1);
  }

  const allStores = storeId === 'all';
  const singleKit = !!kitId;

  log.info(
    `📥 Iniciando actualización de kits BigCommerce. storeId=${storeId}, kitId=${kitId || 'null'}, all=${allStores}`
  );

  let mysqlConn = null;
  let fbDb = null;
  let mongoClient = null;
  let productsCol = null;

  const startTime = Date.now();

  try {
    log.info('📊 Conectando a MySQL (prontoweb)...');
    mysqlConn = await getMySqlConnection();
    log.info('✅ Conectado a MySQL.');

    log.info('📊 Conectando a Firebird (IDEAL)...');
    fbDb = await getFirebirdConnection();
    log.info('✅ Conectado a Firebird.');

    log.info('💾 Conectando a MongoDB (Products)...');
    const mongoConn = await connectMongo();
    mongoClient = mongoConn.client;
    productsCol = mongoConn.productsCol;

    let storesToProcess = [];

    if (allStores) {
      const [rows] = await mysqlConn.query(
        'SELECT DISTINCT store_id FROM kits_master WHERE active="Y" AND store_id IS NOT NULL'
      );
      storesToProcess = rows.map((r) => String(r.store_id));
    } else {
      storesToProcess = [storeId];
    }

    for (const sId of storesToProcess) {
      log.info('===============================================');
      log.info(`📥 Procesando storeId=${sId}`);
      log.info('===============================================');

      const { bcClient, storeDescription } = await getBigCommerceClient(mysqlConn, sId);

      let kits = [];
      let baseMongoProduct = null; // sólo se usa en modo singleKit

      if (singleKit) {
        // ---- MODO UN SOLO KIT: buscamos por ID de producto BigCommerce en Mongo ----
        const mongoProduct = await getMongoProduct(productsCol, sId, kitId);
        if (!mongoProduct) {
          log.warn(
            `⚠ No se encontró producto en Mongo para STOREID=${sId} con ID=${kitId}. Se omite esta combinación.`
          );
          continue;
        }

        baseMongoProduct = mongoProduct;
        const sku = mongoProduct.SKU;
        const brandIdBC = mongoProduct.BRAND_ID;

        log.info(
          `💾 Producto Mongo encontrado para storeId=${sId}. SKU='${sku}', BRAND_ID=${brandIdBC}`
        );

        // 1) Intento con active='Y'
        const [rowsActive] = await mysqlConn.query(
          'SELECT * FROM kits_master WHERE store_id = ? AND sku = ? AND active="Y" LIMIT 1',
          [sId, sku]
        );

        if (rowsActive.length) {
          kits = rowsActive;
        } else {
          // 2) Intento sin filtrar active (puede estar N)
          const [rowsAny] = await mysqlConn.query(
            'SELECT * FROM kits_master WHERE store_id = ? AND sku = ? LIMIT 1',
            [sId, sku]
          );
          if (rowsAny.length) {
            kits = rowsAny;
            log.warn(
              `⚠ Kit sku='${sku}' encontrado en kits_master pero active!='Y'. Se procesará igualmente.`
            );
          }
        }

        if (!kits.length) {
          log.warn(
            `⚠ No se encontraron registros en kits_master para storeId=${sId} y kit relacionado a BigCommerce product ID=${kitId}.`
          );
          continue;
        }
      } else {
        // ---- MODO MASIVO POR STORE: solo activos ----
        const [rows] = await mysqlConn.query(
          'SELECT * FROM kits_master WHERE active="Y" AND store_id = ?',
          [sId]
        );
        kits = rows;

        if (!kits.length) {
          log.warn(`⚠ No se encontraron kits activos en kits_master para storeId=${sId}.`);
          continue;
        }
      }

      log.info(`📥 ${kits.length} kit(s) encontrados en kits_master para storeId=${sId}.`);

      // Cache de mapeo BRAND_ID → MFRID
      const brandToMfrCache = {};

      for (const kit of kits) {
        // Para cada kit necesitamos el producto de Mongo por SKU
        const mongoCacheKey = `${sId}||${kit.sku}`;
        let mongoProd = mongoProductBySkuCache.get(mongoCacheKey);

        if (!mongoProd) {
          mongoProd = await productsCol.findOne({
            STOREID: Number(sId),
            SKU: kit.sku,
          });
          if (mongoProd) {
            mongoProductBySkuCache.set(mongoCacheKey, mongoProd);
          }
        }

        if (!mongoProd) {
          log.warn(
            `⚠ No se encontró producto Mongo para kit sku='${kit.sku}' en storeId=${sId}. Se omite.`
          );
          continue;
        }

        const productIdBC = mongoProd.ID;
        const brandIdBC = mongoProd.BRAND_ID;
        const kitBrand = mongoProd.BRAND || '';
        const kitSku = kit.sku;

        log.info(
          `📊 Procesando kit para storeId=${sId}, BigCommerce product ID=${productIdBC}, SKU='${kitSku}', BRAND_ID=${brandIdBC}`
        );

        let mfrid = brandToMfrCache[brandIdBC];
        if (!mfrid) {
          mfrid = await getMfrIdFromBrand(mysqlConn, sId, brandIdBC);
          if (!mfrid) {
            log.warn(
              `⚠ No se encontró mfrid en brandsandstores para storeid=${sId}, brand_id=${brandIdBC}. Se omite kit sku='${kitSku}'.`
            );
            continue;
          }
          brandToMfrCache[brandIdBC] = mfrid;
        }

        log.info(`✅ MFRID IDEAL obtenido desde brandsandstores: '${mfrid}'`);

        const {
          baseCost,
          componentsCount,
          missingCost,
        } = await calculateBaseCostForKit(mysqlConn, fbDb, kit, mfrid, {
          storeId: sId,
          storeDescription,
          kitBrand,
          kitSku,
        });

        if (missingCost) {
          log.warn(
            `⚠ Kit id=${kit.id}, sku='${kitSku}' tiene componentes sin costo válido. No se actualizará.`
          );
          continue;
        }

        if (!componentsCount) {
          log.warn(
            `⚠ Kit id=${kit.id}, sku='${kitSku}' no tiene componentes válidos. Se omite.`
          );
          continue;
        }

        if (baseCost <= 0) {
          log.warn(
            `⚠ Costo base calculado en 0 para kit id=${kit.id}, sku='${kitSku}'. Se omite.`
          );
          continue;
        }

        log.info(
          `💰 Costo base total del kit id=${kit.id}, sku='${kitSku}' = ${baseCost.toFixed(2)}`
        );

        const defaultMargin = Number(kit.default_price_margin || 0);
        const msrpMargin =
          kit.msrp_margin && kit.msrp_margin !== 'not'
            ? Number(kit.msrp_margin || 0)
            : 0;

        log.info(
          `📐 Márgenes default_price_margin=${defaultMargin}%, msrp_margin=${msrpMargin}%`
        );

        const prices = calculatePrices(baseCost, defaultMargin, msrpMargin);

        log.info(
          `💾 Nuevos valores => cost=${prices.cost.toFixed(
            2
          )}, price=${prices.price.toFixed(
            2
          )}, retail_price=${prices.retailPrice.toFixed(2)}`
        );

        try {
          await updateBigCommerceProduct(
            bcClient,
            productIdBC,
            prices.price,
            prices.retailPrice,
            prices.cost
          );
        } catch {
          // si falla BigCommerce, no intentamos Mongo
          continue;
        }

        await updateMongoProductPrices(productsCol, sId, productIdBC, prices);

        log.info(
          `✅ Kit sku='${kitSku}' (productId=${productIdBC}) actualizado en BigCommerce y Mongo.`
        );
      }
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info(
      `💾 Proceso de actualización de kits finalizado. ⏱ Duración total: ${totalSeconds} s`
    );
  } catch (err) {
    log.error('❌ Error general en updateKitsPricesBigCommerce', err);
  } finally {
    if (fbDb) {
      try {
        fbDb.detach();
        log.info('💾 Conexión Firebird cerrada.');
      } catch (e) {
        log.warn('⚠ Error al cerrar conexión Firebird', e);
      }
    }

    if (mysqlConn) {
      try {
        await mysqlConn.end();
        log.info('📊 Conexión MySQL cerrada.');
      } catch (e) {
        log.warn('⚠ Error al cerrar conexión MySQL', e);
      }
    }

    if (mongoClient && typeof mongoClient.close === 'function') {
      try {
        await mongoClient.close();
        log.info('💾 Conexión MongoDB cerrada.');
      } catch (e) {
        log.warn('⚠ Error al cerrar conexión MongoDB', e);
      }
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
