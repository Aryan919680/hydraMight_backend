const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const firebaseAdmin = require("../config/firebase");

const router = express.Router();

function normalizeMobile(phoneNumber) {
  if (!phoneNumber) return null;

  const digits = String(phoneNumber).replace(/\D/g, "");

  if (digits.length === 10) {
    return `91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith("91")) {
    return digits;
  }

  return digits;
}

function createCustomerJwt(user) {
  return jwt.sign(
    {
      id: user.id,
      mobile: user.mobile,
      user_type: user.user_type,
      customer_type: user.customer_type,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    }
  );
}

/**
 * Firebase household customer login
 *
 * Frontend verifies OTP using Firebase
 * Frontend sends Firebase idToken to this API
 */
router.post("/firebase-login", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const { idToken, full_name } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: "Firebase idToken is required",
      });
    }

    const decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);

    const firebaseUid = decodedToken.uid;
    const firebasePhone = decodedToken.phone_number;

    if (!firebaseUid || !firebasePhone) {
      return res.status(400).json({
        success: false,
        message: "Valid Firebase phone token is required",
      });
    }

    const mobile = normalizeMobile(firebasePhone);

    await client.query("BEGIN");

    const result = await client.query(
      `
      insert into user_profiles
      (
        firebase_uid,
        full_name,
        mobile,
        user_type,
        customer_type,
        status,
        auth_provider,
        phone_verified,
        phone_verified_at,
        last_login_at,
        created_at,
        updated_at
      )
      values
      (
        $1,
        $2,
        $3,
        'customer',
        'household',
        'active',
        'firebase_phone',
        true,
        now(),
        now(),
        now(),
        now()
      )
      on conflict (firebase_uid)
      do update set
        mobile = excluded.mobile,
        full_name = coalesce(nullif(excluded.full_name, ''), user_profiles.full_name),
        user_type = 'customer',
        customer_type = 'household',
        status = 'active',
        auth_provider = 'firebase_phone',
        phone_verified = true,
        phone_verified_at = now(),
        last_login_at = now(),
        updated_at = now()
      returning
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        auth_provider,
        phone_verified,
        last_login_at
      `,
      [firebaseUid, full_name || null, mobile]
    );

    const user = result.rows[0];

    const token = createCustomerJwt(user);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Login successful",
      token,
      user,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Firebase login error:", error);

    res.status(401).json({
      success: false,
      message: error.message || "Firebase login failed",
    });
  } finally {
    client.release();
  }
});

/**
 * Optional customer profile API.
 * Requires HydraMight JWT from firebase-login response.
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

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.user_type !== "customer" || decoded.customer_type !== "household") {
      return res.status(403).json({
        success: false,
        message: "Only household customers are allowed",
      });
    }

    const result = await db.query(
      `
      select
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        auth_provider,
        phone_verified,
        last_login_at
      from user_profiles
      where id = $1
      and user_type = 'customer'
      and customer_type = 'household'
      limit 1
      `,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
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