const express = require("express");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");
const pool = require("../config/db");

const router = express.Router();

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const generateDefaultPassword = (contactPerson) => {
  const firstName = String(contactPerson || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

  return `${firstName}@123`;
};

const validateRequired = (fields, body) => {
  const missing = [];

  for (const field of fields) {
    if (
      body[field] === undefined ||
      body[field] === null ||
      String(body[field]).trim() === ""
    ) {
      missing.push(field);
    }
  }

  return missing;
};

/**
 * Admin Create Stockist
 * POST /api/admin/distributors/stockists
 */
router.post("/stockists",  async (req, res) => {
  const client = await pool.connect();

  try {
    const requiredFields = [
      "gst_number",
      "business_name",
      "contact_person",
      "mobile",
      "email",
      "address_line1",
      "state",
    ];

    const missing = validateRequired(requiredFields, req.body);

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
        missing,
      });
    }

    const {
      gst_number,
      business_name,
      contact_person,
      mobile,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
    } = req.body;

    const email = normalizeEmail(req.body.email);
    const defaultPassword = generateDefaultPassword(contact_person);
    const passwordHash = await bcrypt.hash(defaultPassword, 10);
    const userId = randomUUID();

    await client.query("BEGIN");

    const existingUser = await client.query(
      `
      select id
      from public.user_profiles
      where lower(email) = lower($1)
         or mobile = $2
      limit 1
      `,
      [email, mobile]
    );

    if (existingUser.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "User with same email or mobile already exists",
      });
    }

    const userResult = await client.query(
      `
      insert into public.user_profiles (
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        password_hash,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4,
        'stockist',
        'distributor',
        'active',
        $5,
        now(),
        now()
      )
      returning id, full_name, mobile, email, user_type, customer_type, status
      `,
      [
        userId,
        contact_person,
        mobile,
        email,
        passwordHash,
      ]
    );

    const stockistResult = await client.query(
      `
      insert into public.stockists (
        user_profile_id,
        gst_number,
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        status,
        created_by
      )
      values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        'active',
        $12
      )
      returning *
      `,
      [
        userId,
        String(gst_number).trim().toUpperCase(),
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2 || null,
        city || null,
        state,
        pincode || null,
        req.user?.id || req.admin?.id || null,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Stockist created successfully",
      data: {
        user: userResult.rows[0],
        stockist: stockistResult.rows[0],
        login: {
          email,
          default_password: defaultPassword,
        },
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("CREATE STOCKIST ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Duplicate GST, email or mobile already exists",
        detail: error.detail,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create stockist",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

/**
 * Admin Get Stockists
 * GET /api/admin/distributors/stockists
 */
router.get("/stockists",  async (req, res) => {
  try {
    const { search = "", status = "", limit = 20, offset = 0 } = req.query;

    const params = [];
    const where = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`
        (
          s.business_name ilike $${params.length}
          or s.contact_person ilike $${params.length}
          or s.email ilike $${params.length}
          or s.mobile ilike $${params.length}
          or s.gst_number ilike $${params.length}
        )
      `);
    }

    if (status) {
      params.push(status);
      where.push(`s.status = $${params.length}`);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    params.push(Number(limit));
    const limitIndex = params.length;

    params.push(Number(offset));
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      select
        s.*,
        u.full_name,
        u.user_type,
        u.customer_type,
        u.status as user_status,
        count(a.id)::int as agency_count
      from public.stockists s
      join public.user_profiles u on u.id = s.user_profile_id
      left join public.agencies a on a.stockist_id = s.id
      ${whereSql}
      group by s.id, u.id
      order by s.created_at desc
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET STOCKISTS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch stockists",
      error: error.message,
    });
  }
});

/**
 * Admin Create Agency Under Stockist
 * POST /api/admin/distributors/agencies
 */
router.post("/agencies",  async (req, res) => {
  const client = await pool.connect();

  try {
    const requiredFields = [
      "stockist_id",
      "gst_number",
      "business_name",
      "contact_person",
      "mobile",
      "email",
      "address_line1",
      "state",
    ];

    const missing = validateRequired(requiredFields, req.body);

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
        missing,
      });
    }

    const {
      stockist_id,
      gst_number,
      business_name,
      contact_person,
      mobile,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
    } = req.body;

    const email = normalizeEmail(req.body.email);
    const defaultPassword = generateDefaultPassword(contact_person);
    const passwordHash = await bcrypt.hash(defaultPassword, 10);
    const userId = randomUUID();

    await client.query("BEGIN");

    const stockistCheck = await client.query(
      `
      select id, status
      from public.stockists
      where id = $1
      `,
      [stockist_id]
    );

    if (stockistCheck.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Parent stockist not found",
      });
    }

    if (stockistCheck.rows[0].status !== "active") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Cannot create agency under inactive stockist",
      });
    }

    const existingUser = await client.query(
      `
      select id
      from public.user_profiles
      where lower(email) = lower($1)
         or mobile = $2
      limit 1
      `,
      [email, mobile]
    );

    if (existingUser.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "User with same email or mobile already exists",
      });
    }

    const userResult = await client.query(
      `
      insert into public.user_profiles (
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        password_hash,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4,
        'agency',
        'distributor',
        'active',
        $5,
        now(),
        now()
      )
      returning id, full_name, mobile, email, user_type, customer_type, status
      `,
      [
        userId,
        contact_person,
        mobile,
        email,
        passwordHash,
      ]
    );

    const agencyResult = await client.query(
      `
      insert into public.agencies (
        stockist_id,
        user_profile_id,
        gst_number,
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        status,
        created_by
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        'active',
        $13
      )
      returning *
      `,
      [
        stockist_id,
        userId,
        String(gst_number).trim().toUpperCase(),
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2 || null,
        city || null,
        state,
        pincode || null,
        req.user?.id || req.admin?.id || null,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Agency created successfully",
      data: {
        user: userResult.rows[0],
        agency: agencyResult.rows[0],
        login: {
          email,
          default_password: defaultPassword,
        },
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("CREATE AGENCY ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Duplicate GST, email or mobile already exists",
        detail: error.detail,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create agency",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

/**
 * Admin Get Agencies
 * GET /api/admin/distributors/agencies
 */
router.get("/agencies",  async (req, res) => {
  try {
    const {
      search = "",
      stockist_id = "",
      status = "",
      limit = 20,
      offset = 0,
    } = req.query;

    const params = [];
    const where = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`
        (
          a.business_name ilike $${params.length}
          or a.contact_person ilike $${params.length}
          or a.email ilike $${params.length}
          or a.mobile ilike $${params.length}
          or a.gst_number ilike $${params.length}
        )
      `);
    }

    if (stockist_id) {
      params.push(stockist_id);
      where.push(`a.stockist_id = $${params.length}`);
    }

    if (status) {
      params.push(status);
      where.push(`a.status = $${params.length}`);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    params.push(Number(limit));
    const limitIndex = params.length;

    params.push(Number(offset));
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      select
        a.*,
        u.full_name,
        u.user_type,
        u.customer_type,
        u.status as user_status,
        s.business_name as stockist_business_name
      from public.agencies a
      join public.user_profiles u on u.id = a.user_profile_id
      join public.stockists s on s.id = a.stockist_id
      ${whereSql}
      order by a.created_at desc
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET AGENCIES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch agencies",
      error: error.message,
    });
  }
});

/**
 * Admin Get Agencies By Stockist
 * GET /api/admin/distributors/stockists/:stockistId/agencies
 */
router.get("/stockists/:stockistId/agencies", async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        a.*,
        u.status as user_status
      from public.agencies a
      join public.user_profiles u on u.id = a.user_profile_id
      where a.stockist_id = $1
      order by a.created_at desc
      `,
      [req.params.stockistId]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET STOCKIST AGENCIES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch agencies",
      error: error.message,
    });
  }
});

module.exports = router;