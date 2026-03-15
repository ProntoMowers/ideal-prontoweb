const axios = require('axios');
const logger = require('../helpers/logger')('respondioContactService.log');
const { getMySqlConnection } = require('../providers/dbConnections');

const RESPONDIO_ACCESS_TOKEN = process.env.RESPONDIO_ACCESS_TOKEN;
const RESPONDIO_API_URL = process.env.RESPONDIO_API_URL || 'https://api.respond.io/v2';

function getHeaders() {
  return {
    Authorization: `Bearer ${RESPONDIO_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function normalizeEmail(email) {
  if (!email) return null;
  const value = String(email).trim().toLowerCase();
  if (!value) return null;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(value) ? value : null;
}

function normalizePhone(phone, defaultCountryCode = '1') {
  if (!phone) return null;
  const raw = String(phone).trim();
  if (!raw) return null;

  if (raw.startsWith('+')) {
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 ? `+${digits}` : null;
  }

  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (!digits.startsWith(defaultCountryCode)) {
    digits = `${defaultCountryCode}${digits}`;
  }

  return digits.length >= 11 ? `+${digits}` : null;
}

function isMobileFormat(value) {
  if (!value) return false;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function normalizeLanguage(languageRaw) {
  if (!languageRaw) return '';
  const language = String(languageRaw).trim().toLowerCase();
  if (language === 'es' || language === 'en') return language;
  return '';
}

function normalizeCountryCode(countryCodeRaw) {
  if (!countryCodeRaw) return '';
  const code = String(countryCodeRaw).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

async function lookupCountryCodeByCountryName(countryName) {
  if (!countryName || !String(countryName).trim()) return '';

  let conn;
  try {
    conn = await getMySqlConnection();
    const [rows] = await conn.execute(
      `SELECT UPPER(TRIM(country_code)) AS country_code
       FROM countries
       WHERE LOWER(TRIM(country_name)) = LOWER(TRIM(?))
       LIMIT 1`,
      [String(countryName).trim()]
    );

    if (!rows || rows.length === 0) return '';
    return normalizeCountryCode(rows[0].country_code);
  } catch (error) {
    logger.warn(`No se pudo resolver countryCode desde countries para '${countryName}': ${error.message}`);
    return '';
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) {}
    }
  }
}

async function resolveCountryCode({ countryCode, country }) {
  const direct = normalizeCountryCode(countryCode);
  if (direct) return direct;
  return lookupCountryCodeByCountryName(country);
}

function resolvePreferredPhone({ cell, phone, countryDialCode }) {
  const normalizedCell = normalizePhone(cell, countryDialCode);
  if (normalizedCell && isMobileFormat(cell)) return normalizedCell;

  const normalizedPhone = normalizePhone(phone, countryDialCode);
  if (normalizedPhone && isMobileFormat(phone)) return normalizedPhone;

  return null;
}

function deriveNames({ firstName, lastName, name, isCompany }) {
  const cleanFirst = (firstName || '').toString().trim();
  const cleanLast = (lastName || '').toString().trim();

  // Regla solicitada: si firstname viene vacío, usar NAME
  const fullName = (name || '').toString().trim();
  const effectiveFirstName = cleanFirst || fullName;

  if (effectiveFirstName && cleanLast) {
    return { firstName: effectiveFirstName, lastName: cleanLast };
  }

  if (fullName) {
    const parts = fullName.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return {
        firstName: effectiveFirstName || parts[0],
        lastName: cleanLast || (isCompany ? 'Company' : 'Customer')
      };
    }
    return {
      firstName: effectiveFirstName || parts[0],
      lastName: cleanLast || parts.slice(1).join(' ')
    };
  }

  return {
    firstName: effectiveFirstName || (isCompany ? 'Company' : 'Customer'),
    lastName: cleanLast || 'Contact'
  };
}

function extractTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .map((tag) => {
      if (typeof tag === 'string') return tag.trim();
      if (tag && typeof tag.name === 'string') return tag.name.trim();
      return '';
    })
    .filter(Boolean);
}

async function findContactByIdentifiers({ email, phone }) {
  if (!RESPONDIO_ACCESS_TOKEN) {
    throw new Error('RESPONDIO_ACCESS_TOKEN no configurado');
  }

  const identifiers = [];
  if (email) identifiers.push(`email:${email}`);
  if (phone) identifiers.push(`phone:${phone}`);

  for (const identifier of identifiers) {
    try {
      const response = await axios.get(`${RESPONDIO_API_URL}/contact/${identifier}`, {
        headers: getHeaders()
      });
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

async function createContact({ identifier, payload }) {
  const response = await axios.post(`${RESPONDIO_API_URL}/contact/${identifier}`, payload, {
    headers: getHeaders()
  });
  return response.data;
}

async function updateContact({ contactId, payload }) {
  const response = await axios.put(`${RESPONDIO_API_URL}/contact/${contactId}`, payload, {
    headers: getHeaders()
  });
  return response.data;
}

async function addTagToContact({ identifier, tag }) {
  await axios.post(
    `${RESPONDIO_API_URL}/contact/${identifier}/tag`,
    [tag],
    { headers: getHeaders() }
  );
}

async function upsertRespondioContact(input) {
  const countryDialCode = String(input.countryDialCode || input.phoneCountryCode || '1').trim();
  const email = normalizeEmail(input.email);
  const phone = resolvePreferredPhone({
    cell: input.cell,
    phone: input.phone,
    countryDialCode
  });
  const language = normalizeLanguage(input.language);
  const countryCode = await resolveCountryCode({
    countryCode: input.countryCode,
    country: input.country
  });

  if (!email && !phone) {
    const err = new Error('Debe enviar al menos un email o phone válido');
    err.statusCode = 400;
    throw err;
  }

  const tag = (input.tag || '').toString().trim();
  if (!tag) {
    const err = new Error('El campo tag es requerido');
    err.statusCode = 400;
    throw err;
  }

  const names = deriveNames({
    firstName: input.firstName || input.firstname,
    lastName: input.lastName || input.lastname,
    name: input.name,
    isCompany: Boolean(input.isCompany)
  });

  const existingContact = await findContactByIdentifiers({ email, phone });

  if (existingContact) {
    const updatePayload = {
      firstName: names.firstName,
      lastName: names.lastName
    };

    if (email) updatePayload.email = email;
    if (phone) updatePayload.phone = phone;
    if (language) updatePayload.language = language;
    if (countryCode) updatePayload.countryCode = countryCode;

    const updated = await updateContact({
      contactId: existingContact.id,
      payload: updatePayload
    });

    await addTagToContact({
      identifier: existingContact.id,
      tag
    });

    logger.info(`Contacto Respond.io actualizado: ${existingContact.id}`);

    return {
      action: 'updated',
      contactId: existingContact.id,
      contact: updated,
      tags: Array.from(new Set([...extractTags(existingContact.tags), tag])),
      normalized: {
        firstName: names.firstName,
        lastName: names.lastName,
        phone,
        email,
        language,
        countryCode
      }
    };
  }

  const identifier = email ? `email:${email}` : `phone:${phone}`;
  const createPayload = {
    firstName: names.firstName,
    lastName: names.lastName
  };

  if (email) createPayload.email = email;
  if (phone) createPayload.phone = phone;
  if (language) createPayload.language = language;
  if (countryCode) createPayload.countryCode = countryCode;

  const created = await createContact({ identifier, payload: createPayload });

  await addTagToContact({
    identifier: created.id || identifier,
    tag
  });

  logger.info(`Contacto Respond.io creado: ${created.id || 'N/A'}`);

  return {
    action: 'created',
    contactId: created.id || null,
    contact: created,
    tags: [tag],
    normalized: {
      firstName: names.firstName,
      lastName: names.lastName,
      phone,
      email,
      language,
      countryCode
    }
  };
}

// ─── Bulk helpers ────────────────────────────────────────────────────────────

const BULK_CONCURRENCY = 3;
const BULK_MAX_RETRIES = 3;
const BULK_BASE_DELAY_MS = 1000;
const BULK_MAX_CONTACTS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, retries = BULK_MAX_RETRIES, delayMs = BULK_BASE_DELAY_MS) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status <= 599);
      if (!isRetryable || attempt > retries) throw error;
      const wait = delayMs * Math.pow(2, attempt - 1);
      logger.warn(`withRetry intento ${attempt}/${retries} — esperando ${wait}ms (HTTP ${status})`);
      await sleep(wait);
    }
  }
}

async function runWithConcurrency(items, concurrency, asyncFn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await asyncFn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Procesa un array de contactos en paralelo (concurrencia = 3).
 * Cada contacto usa withRetry para reintentar en 429 / 5xx.
 *
 * @param {{ contacts: Array<object>, defaultTag?: string }} param
 * @returns {{ total, created, updated, errors: Array<{index, email, reason}> }}
 */
async function upsertRespondioContactBulk({ contacts, defaultTag }) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    const err = new Error('contacts debe ser un array no vacío');
    err.statusCode = 400;
    throw err;
  }

  if (contacts.length > BULK_MAX_CONTACTS) {
    const err = new Error(`El bulk no puede superar ${BULK_MAX_CONTACTS} contactos por solicitud`);
    err.statusCode = 400;
    throw err;
  }

  logger.info(`Bulk upsert iniciado: ${contacts.length} contactos`);

  const rawResults = await runWithConcurrency(contacts, BULK_CONCURRENCY, async (contactInput, idx) => {
    try {
      const input = { ...contactInput };
      if (!input.tag && defaultTag) input.tag = defaultTag;

      const result = await withRetry(() => upsertRespondioContact(input));

      return { index: idx, success: true, action: result.action, contactId: result.contactId };
    } catch (error) {
      logger.warn(`Bulk idx ${idx} (${contactInput.email || '?'}) falló: ${error.message}`);
      return {
        index: idx,
        success: false,
        email: contactInput.email || null,
        reason: error.message || 'Error desconocido'
      };
    }
  });

  const summary = { total: contacts.length, created: 0, updated: 0, errors: [] };

  for (const r of rawResults) {
    if (r.success) {
      if (r.action === 'created') summary.created++;
      else summary.updated++;
    } else {
      summary.errors.push({ index: r.index, email: r.email, reason: r.reason });
    }
  }

  logger.info(
    `Bulk upsert completado: ${summary.created} creados, ${summary.updated} actualizados, ${summary.errors.length} errores`
  );

  return summary;
}

module.exports = {
  upsertRespondioContact,
  upsertRespondioContactBulk
};
