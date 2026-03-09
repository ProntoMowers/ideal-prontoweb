// providers/dbConnections.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const Firebird = require('node-firebird');
const mssql = require('mssql');
const { Pool } = require('pg');

async function getMySqlConnection() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    multipleStatements: false
  });
  return conn;
}

function getFirebirdConnection() {
  return new Promise((resolve, reject) => {
    const options = {
      host: process.env.FB_HOST,
      port: Number(process.env.FB_PORT || 3050),
      database: process.env.FB_DATABASE,
      user: process.env.FB_USER,
      password: process.env.FB_PASSWORD,
      lowercase_keys: (process.env.FB_LOWERCASE_KEYS || 'false') === 'true',
      role: null,
      pageSize: 4096,
    };

    Firebird.attach(options, (err, db) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

// Helper para hacer query en Firebird como promesa
function fbQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function getMssqlConnection() {
  const config = {
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    server: process.env.MSSQL_HOST, // Ej: '192.168.1.10'
    database: process.env.MSSQL_DATABASE,
    options: {
      encrypt: false, // Cambiar a true si usas Azure
      trustServerCertificate: true,
      instanceName: 'SHIPWORKS1' // Según tus datos: SHIPWORKS1
    }
  };
  return await mssql.connect(config);
}

// PostgreSQL Connection Pool
let pgPool = null;

function getPostgresPool() {
  if (!pgPool) {
    pgPool = new Pool({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT || 5432),
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return pgPool;
}

module.exports = {
  getMySqlConnection,
  getFirebirdConnection,
  getMssqlConnection,
  getPostgresPool,
  fbQuery,
};
