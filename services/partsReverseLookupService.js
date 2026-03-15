const { MongoClient } = require('mongodb');
const { getMySqlConnection } = require('../providers/dbConnections');
const logger = require('../helpers/logger')('partsReverseLookupService.log');

function normalizePart(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function toOptionalFilterValue(value) {
  if (value === undefined || value === null) return null;
  const parsed = String(value).trim();
  return parsed === '' ? null : parsed;
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://10.1.10.65:27017';
  const dbName = process.env.MONGO_DB || 'Prontoweb';
  const productsCollection = process.env.MONGO_PRODUCTS_COLLECTION || 'Products';

  const client = new MongoClient(uri, { connectTimeoutMS: 30000 });
  await client.connect();

  const db = client.db(dbName);
  const productsCol = db.collection(productsCollection);

  logger.info(`Mongo conectado: ${uri} db=${dbName} col=${productsCollection}`);
  return { client, productsCol };
}

async function getMfrContext(mysqlConn, mfridInput) {
  const mfrid = String(mfridInput || '').trim().toUpperCase();

  const [rows] = await mysqlConn.query(
    `SELECT mfrid, mfr_equiv, sufsku
     FROM brands
     WHERE mfrid = ? OR mfr_equiv = ? OR mfrid = (SELECT mfr_equiv FROM brands WHERE mfrid = ? LIMIT 1)`,
    [mfrid, mfrid, mfrid]
  );

  const mfrSet = new Set([mfrid]);
  const suffixByMfr = new Map();

  for (const row of rows) {
    const currentMfr = String(row.mfrid || '').trim().toUpperCase();
    const equivMfr = String(row.mfr_equiv || '').trim().toUpperCase();

    if (currentMfr) {
      mfrSet.add(currentMfr);
      suffixByMfr.set(currentMfr, String(row.sufsku || '').trim());
    }

    if (equivMfr) {
      mfrSet.add(equivMfr);
    }
  }

  return {
    candidateMfrIds: [...mfrSet],
    suffixByMfr,
  };
}

function buildNormalizedPartMap(partnumber, candidateMfrIds, suffixByMfr) {
  const rawNormalized = normalizePart(partnumber);
  const normalizedByMfr = new Map();

  for (const mfrid of candidateMfrIds) {
    const suffix = normalizePart(suffixByMfr.get(mfrid) || '');
    let candidate = rawNormalized;

    if (suffix && candidate.startsWith(suffix)) {
      candidate = candidate.slice(suffix.length);
    }

    normalizedByMfr.set(mfrid, candidate);
  }

  return normalizedByMfr;
}

async function getBrandStores(mysqlConn, candidateMfrIds, clearence, newproduct) {
  const placeholders = candidateMfrIds.map(() => '?').join(',');
  const params = [...candidateMfrIds];

  let query = `
    SELECT storeid, mfrid, brandbc, clearence, newproduct
    FROM brandsandstores
    WHERE mfrid IN (${placeholders})
  `;

  if (clearence !== null) {
    query += ' AND clearence = ?';
    params.push(clearence);
  }

  if (newproduct !== null) {
    query += ' AND newproduct = ?';
    params.push(newproduct);
  }

  const [rows] = await mysqlConn.query(query, params);
  return rows;
}

async function findMongoProductsByBrandStore(productsCol, brandStoreRow, normalizedPartTarget) {
  if (!brandStoreRow.brandbc) return [];

  const mongoFilter = {
    STOREID: Number(brandStoreRow.storeid),
    BRAND: { $regex: `^${escapeRegex(String(brandStoreRow.brandbc))}$`, $options: 'i' },
    availability: { $ne: 'disabled' },
    MPN: { $exists: true, $ne: null },
  };

  const projection = {
    _id: 0,
    STOREID: 1,
    BRAND: 1,
    MPN: 1,
    SKU: 1,
    ID: 1,
    availability: 1,
  };

  const docs = await productsCol.find(mongoFilter).project(projection).toArray();

  return docs.filter((doc) => normalizePart(doc.MPN) === normalizedPartTarget);
}

async function reverseLookupParts(parts, options = {}) {
  const clearenceFilter = toOptionalFilterValue(options.clearence);
  const newproductFilter = toOptionalFilterValue(options.newproduct);

  let mysqlConn = null;
  let mongoClient = null;

  try {
    mysqlConn = await getMySqlConnection();
    const mongo = await connectMongo();
    mongoClient = mongo.client;
    const productsCol = mongo.productsCol;

    const results = [];

    for (const part of parts) {
      const inputMfrid = String(part.mfrid || '').trim().toUpperCase();
      const inputPartnumber = String(part.partnumber || '').trim();

      const result = {
        input: {
          mfrid: inputMfrid,
          partnumber: inputPartnumber,
        },
        candidateMfrIds: [],
        storesChecked: 0,
        matches: [],
        totalMatches: 0,
        success: false,
        error: null,
      };

      try {
        const { candidateMfrIds, suffixByMfr } = await getMfrContext(mysqlConn, inputMfrid);
        result.candidateMfrIds = candidateMfrIds;

        const normalizedPartByMfr = buildNormalizedPartMap(
          inputPartnumber,
          candidateMfrIds,
          suffixByMfr
        );

        const brandStoreRows = await getBrandStores(
          mysqlConn,
          candidateMfrIds,
          clearenceFilter,
          newproductFilter
        );

        result.storesChecked = brandStoreRows.length;

        const dedupe = new Set();
        for (const row of brandStoreRows) {
          const rowMfr = String(row.mfrid || '').trim().toUpperCase();
          const normalizedTarget = normalizedPartByMfr.get(rowMfr) || normalizePart(inputPartnumber);
          const docs = await findMongoProductsByBrandStore(productsCol, row, normalizedTarget);

          for (const doc of docs) {
            const uniqueKey = `${doc.STOREID}::${doc.ID}`;
            if (dedupe.has(uniqueKey)) continue;
            dedupe.add(uniqueKey);

            result.matches.push({
              STOREID: doc.STOREID,
              BRAND: doc.BRAND,
              MPN: doc.MPN,
              SKU: doc.SKU,
              ID: doc.ID,
            });
          }
        }

        result.totalMatches = result.matches.length;
        result.success = true;
      } catch (error) {
        result.error = error.message;
        logger.error(`Error procesando reverse lookup para ${inputMfrid}/${inputPartnumber}`, error);
      }

      results.push(result);
    }

    return {
      clearence: clearenceFilter,
      newproduct: newproductFilter,
      totalRequested: parts.length,
      totalMatches: results.reduce((acc, item) => acc + (item.totalMatches || 0), 0),
      results,
    };
  } finally {
    if (mysqlConn) await mysqlConn.end();
    if (mongoClient) await mongoClient.close();
  }
}

module.exports = {
  reverseLookupParts,
};
