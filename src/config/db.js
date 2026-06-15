const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 6543),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
});

pool.on("connect", () => {
  console.log("PostgreSQL pool connected");
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

/**
 * IMPORTANT:
 * This export intentionally supports all existing code styles in this backend:
 * 1. const db = require("../config/db"); await db.query(...)
 * 2. const db = require("../config/db"); await db.pool.connect()
 * 3. const pool = require("../config/db"); await pool.connect()
 * 4. const { pool } = require("../config/db"); await pool.connect()
 */
pool.pool = pool;
pool.query = pool.query.bind(pool);

module.exports = pool;
module.exports.pool = pool;
module.exports.query = pool.query;
