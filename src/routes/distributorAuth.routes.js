const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const pool = db.pool || db;
const router = express.Router();

const normalizeEmail = (email) =>
  String(email || "").trim().toLowerCase();

async function getStockistProfile(userProfileId) {
  const result = await pool.query(
    `
    select *
    from public.stockists
    where user_profile_id = $1
    limit 1
    `,
    [userProfileId]
  );

  return result.rows[0] || null;
}

async function getAgencyProfile(userProfileId) {
  const result = await pool.query(
    `
    select
      a.*,

      'stockist'::text as fulfillment_source,

      s.business_name as stockist_business_name,
      s.gst_number as stockist_gst_number,
      s.status as stockist_status

    from public.agencies a

    left join public.stockists s
      on s.id = a.stockist_id

    where a.user_profile_id = $1
    limit 1
    `,
    [userProfileId]
  );

  return result.rows[0] || null;
}

function validateAgencySupplier(agency) {
  if (!agency) {
    return "Agency profile not found";
  }

  if (String(agency.status || "").toLowerCase() !== "active") {
    return "Agency account is inactive";
  }

  /*
    Unassigned agency is valid.
    It can browse all active Stockist catalogues.
  */
  if (
    agency.stockist_id &&
    String(agency.stockist_status || "").toLowerCase() !== "active"
  ) {
    return "Assigned stockist is inactive";
  }

  return null;
}

router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const userResult = await pool.query(
      `
      select
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        password_hash
      from public.user_profiles
      where lower(email) = lower($1)
        and user_type in ('stockist', 'agency')
      limit 1
      `,
      [email]
    );

    if (userResult.rowCount === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = userResult.rows[0];

    if (String(user.status || "").toLowerCase() !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your account is not active",
      });
    }

    const passwordValid = await bcrypt.compare(
      password,
      user.password_hash || ""
    );

    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    let stockist = null;
    let agency = null;

    if (user.user_type === "stockist") {
      stockist = await getStockistProfile(user.id);

      if (!stockist) {
        return res.status(403).json({
          success: false,
          message: "Stockist profile not found",
        });
      }

      if (String(stockist.status || "").toLowerCase() !== "active") {
        return res.status(403).json({
          success: false,
          message: "Stockist account is inactive",
        });
      }
    }

    if (user.user_type === "agency") {
      agency = await getAgencyProfile(user.id);

      const agencyError = validateAgencySupplier(agency);

      if (agencyError) {
        return res.status(403).json({
          success: false,
          message: agencyError,
        });
      }
    }

    const tokenPayload = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      mobile: user.mobile,
      user_type: user.user_type,
      customer_type: user.customer_type,
      stockist_id: stockist?.id || agency?.stockist_id || null,
      agency_id: agency?.id || null,
      fulfillment_source: agency?.fulfillment_source || "stockist",
    };

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
      }
    );

    return res.json({
      success: true,
      message: "Distributor login successful",
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        mobile: user.mobile,
        email: user.email,
        user_type: user.user_type,
        customer_type: user.customer_type,
        status: user.status,
        stockist_id: tokenPayload.stockist_id,
        agency_id: tokenPayload.agency_id,
        fulfillment_source: tokenPayload.fulfillment_source,
      },
      profile: {
        stockist,
        agency,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Distributor login failed",
      error: error.message,
    });
  }
});

router.get("/me", async (req, res) => {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Token missing",
      });
    }

    const decoded = jwt.verify(
      authorization.slice(7),
      process.env.JWT_SECRET
    );

    const userResult = await pool.query(
      `
      select
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status
      from public.user_profiles
      where id = $1
        and user_type in ('stockist', 'agency')
      limit 1
      `,
      [decoded.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Distributor user not found",
      });
    }

    const user = userResult.rows[0];

    const stockist =
      user.user_type === "stockist"
        ? await getStockistProfile(user.id)
        : null;

    const agency =
      user.user_type === "agency"
        ? await getAgencyProfile(user.id)
        : null;

    return res.json({
      success: true,
      data: {
        user,
        stockist,
        agency,
      },
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: error.message,
    });
  }
});

module.exports = router;