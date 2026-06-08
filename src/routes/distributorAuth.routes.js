const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const router = express.Router();

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

/**
 * Distributor Login
 * Stockist and Agency login from user_profiles table
 *
 * POST /api/distributor/auth/login
 */
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

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your account is not active",
      });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password_hash || ""
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    let stockist = null;
    let agency = null;

    /**
     * Stockist login validation
     */
    if (user.user_type === "stockist") {
      const stockistResult = await pool.query(
        `
        select
          id,
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
          status
        from public.stockists
        where user_profile_id = $1
        limit 1
        `,
        [user.id]
      );

      if (stockistResult.rowCount === 0) {
        return res.status(403).json({
          success: false,
          message: "Stockist profile not found",
        });
      }

      stockist = stockistResult.rows[0];

      if (stockist.status !== "active") {
        return res.status(403).json({
          success: false,
          message: "Stockist account is inactive",
        });
      }
    }

    /**
     * Agency login validation
     */
    if (user.user_type === "agency") {
      const agencyResult = await pool.query(
        `
        select
          a.id,
          a.stockist_id,
          a.user_profile_id,
          a.gst_number,
          a.business_name,
          a.contact_person,
          a.mobile,
          a.email,
          a.address_line1,
          a.address_line2,
          a.city,
          a.state,
          a.pincode,
          a.status,

          s.business_name as stockist_business_name,
          s.status as stockist_status
        from public.agencies a
        join public.stockists s on s.id = a.stockist_id
        where a.user_profile_id = $1
        limit 1
        `,
        [user.id]
      );

      if (agencyResult.rowCount === 0) {
        return res.status(403).json({
          success: false,
          message: "Agency profile not found",
        });
      }

      agency = agencyResult.rows[0];

      if (agency.status !== "active") {
        return res.status(403).json({
          success: false,
          message: "Agency account is inactive",
        });
      }

      if (agency.stockist_status !== "active") {
        return res.status(403).json({
          success: false,
          message: "Parent stockist is inactive",
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
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    });

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
      },
      profile: {
        stockist,
        agency,
      },
    });
  } catch (error) {
    console.error("DISTRIBUTOR LOGIN ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Distributor login failed",
      error: error.message,
    });
  }
});

/**
 * Distributor Me API
 *
 * GET /api/distributor/auth/me
 */
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Token missing",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!["stockist", "agency"].includes(decoded.user_type)) {
      return res.status(403).json({
        success: false,
        message: "Distributor access only",
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

    let stockist = null;
    let agency = null;

    if (user.user_type === "stockist") {
      const stockistResult = await pool.query(
        `
        select *
        from public.stockists
        where user_profile_id = $1
        limit 1
        `,
        [user.id]
      );

      stockist = stockistResult.rows[0] || null;
    }

    if (user.user_type === "agency") {
      const agencyResult = await pool.query(
        `
        select
          a.*,
          s.business_name as stockist_business_name,
          s.gst_number as stockist_gst_number,
          s.status as stockist_status
        from public.agencies a
        join public.stockists s on s.id = a.stockist_id
        where a.user_profile_id = $1
        limit 1
        `,
        [user.id]
      );

      agency = agencyResult.rows[0] || null;
    }

    return res.json({
      success: true,
      data: {
        user,
        stockist,
        agency,
      },
    });
  } catch (error) {
    console.error("DISTRIBUTOR ME ERROR:", error);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: error.message,
    });
  }
});

module.exports = router;