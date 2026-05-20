const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const router = express.Router();

const DUMMY_OTP = process.env.CUSTOMER_DUMMY_OTP || "123456";
const JWT_SECRET = process.env.JWT_SECRET || "hydramight_customer_dev_secret";
const JWT_EXPIRES_IN = process.env.CUSTOMER_JWT_EXPIRES_IN || "30d";

function normalizeMobile(mobile) {
  if (!mobile) return "";

  let value = String(mobile).trim();

  // remove spaces, hyphen, brackets
  value = value.replace(/[\s\-()]/g, "");

  // If user enters +91XXXXXXXXXX
  if (value.startsWith("+")) {
    value = value.substring(1);
  }

  // If user enters 10 digit Indian mobile
  if (/^[6-9]\d{9}$/.test(value)) {
    value = `91${value}`;
  }

  return value;
}

function isValidIndianMobile(mobile) {
  return /^91[6-9]\d{9}$/.test(mobile);
}

function createCustomerToken(user) {
  return jwt.sign(
    {
      id: user.id,
      mobile: user.mobile,
      email: user.email || null,
      full_name: user.full_name || null,
      user_type: user.user_type,
      customer_type: user.customer_type || "household",
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );
}

/**
 * POST /api/customer/auth/send-otp
 *
 * Dummy OTP flow:
 * Body:
 * {
 *   "mobile": "9876543210",
 *   "customer_type": "household"
 * }
 */
router.post("/send-otp", async (req, res) => {
  try {
    const { mobile, customer_type = "household" } = req.body;

    const normalizedMobile = normalizeMobile(mobile);

    if (!isValidIndianMobile(normalizedMobile)) {
      return res.status(400).json({
        success: false,
        message: "Valid Indian mobile number is required",
      });
    }

    if (!["household", "commercial"].includes(customer_type)) {
      return res.status(400).json({
        success: false,
        message: "customer_type must be household or commercial",
      });
    }

    // expire old pending OTP sessions for same mobile
    await db.query(
      `update customer_otp_sessions
       set status = 'expired'
       where mobile = $1
       and status = 'pending'`,
      [normalizedMobile]
    );

    const result = await db.query(
      `insert into customer_otp_sessions
       (
        mobile,
        otp_code,
        customer_type,
        purpose,
        status,
        expires_at,
        created_at
       )
       values ($1,$2,$3,'login','pending',now() + interval '10 minutes',now())
       returning id, mobile, customer_type, expires_at`,
      [normalizedMobile, DUMMY_OTP, customer_type]
    );

    res.json({
      success: true,
      message: "Dummy OTP generated successfully",
      data: {
        request_id: result.rows[0].id,
        mobile: normalizedMobile,
        customer_type,
        expires_at: result.rows[0].expires_at,

        // dev only
        dummy_otp: DUMMY_OTP,
      },
    });
  } catch (error) {
    console.error("Customer send OTP error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to send OTP",
    });
  }
});

/**
 * POST /api/customer/auth/verify-otp
 *
 * Body:
 * {
 *   "mobile": "9876543210",
 *   "otp": "123456",
 *   "full_name": "Rajesh",
 *   "email": "optional@email.com"
 * }
 */
router.post("/verify-otp", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      mobile,
      otp,
      full_name,
      email,
      customer_type = "household",
    } = req.body;

    const normalizedMobile = normalizeMobile(mobile);

    if (!isValidIndianMobile(normalizedMobile)) {
      return res.status(400).json({
        success: false,
        message: "Valid Indian mobile number is required",
      });
    }

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: "OTP is required",
      });
    }

    await client.query("BEGIN");

    const otpResult = await client.query(
      `select *
       from customer_otp_sessions
       where mobile = $1
       and status = 'pending'
       and expires_at > now()
       order by created_at desc
       limit 1
       for update`,
      [normalizedMobile]
    );

    if (otpResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "OTP expired or not found. Please request a new OTP.",
      });
    }

    const otpSession = otpResult.rows[0];

    if (Number(otpSession.attempts || 0) >= Number(otpSession.max_attempts || 5)) {
      await client.query(
        `update customer_otp_sessions
         set status = 'failed'
         where id = $1`,
        [otpSession.id]
      );

      await client.query("ROLLBACK");

      return res.status(429).json({
        success: false,
        message: "Maximum OTP attempts exceeded. Please request a new OTP.",
      });
    }

    if (String(otp) !== String(otpSession.otp_code)) {
      await client.query(
        `update customer_otp_sessions
         set attempts = attempts + 1
         where id = $1`,
        [otpSession.id]
      );

      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    await client.query(
      `update customer_otp_sessions
       set status = 'verified',
           verified_at = now()
       where id = $1`,
      [otpSession.id]
    );

    const existingUserResult = await client.query(
      `select *
       from user_profiles
       where mobile = $1
       limit 1`,
      [normalizedMobile]
    );

    let user;

    if (existingUserResult.rows.length > 0) {
      const updateResult = await client.query(
        `update user_profiles
         set
          full_name = coalesce($1, full_name),
          email = coalesce($2, email),
          user_type = 'customer',
          customer_type = coalesce($3, customer_type, 'household'),
          status = 'active',
          login_provider = 'dummy_otp',
          is_mobile_verified = true,
          last_login_at = now(),
          updated_at = now()
         where mobile = $4
         returning *`,
        [
          full_name || null,
          email || null,
          customer_type || otpSession.customer_type || "household",
          normalizedMobile,
        ]
      );

      user = updateResult.rows[0];
    } else {
      const insertResult = await client.query(
        `insert into user_profiles
         (
          id,
          full_name,
          mobile,
          email,
          user_type,
          customer_type,
          status,
          login_provider,
          is_mobile_verified,
          last_login_at,
          created_at,
          updated_at
         )
         values
         (
          uuid_generate_v4(),
          $1,
          $2,
          $3,
          'customer',
          $4,
          'active',
          'dummy_otp',
          true,
          now(),
          now(),
          now()
         )
         returning *`,
        [
          full_name || null,
          normalizedMobile,
          email || null,
          customer_type || otpSession.customer_type || "household",
        ]
      );

      user = insertResult.rows[0];
    }

    const token = createCustomerToken(user);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Customer logged in successfully",
      data: {
        token,
        user: {
          id: user.id,
          full_name: user.full_name,
          mobile: user.mobile,
          email: user.email,
          user_type: user.user_type,
          customer_type: user.customer_type,
          status: user.status,
          is_mobile_verified: user.is_mobile_verified,
        },
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Customer verify OTP error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to verify OTP",
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/customer/auth/me
 */
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await db.query(
      `select
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        is_mobile_verified,
        last_login_at,
        created_at,
        updated_at
       from user_profiles
       where id = $1
       and user_type = 'customer'
       and status = 'active'
       limit 1`,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Customer not found or inactive",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Customer me error:", error);

    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
});

module.exports = router;