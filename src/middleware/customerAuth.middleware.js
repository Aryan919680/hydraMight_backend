const jwt = require("jsonwebtoken");
const db = require("../config/db");

const JWT_SECRET = process.env.JWT_SECRET || "hydramight_customer_dev_secret";

async function authenticateCustomer(req, res, next) {
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
        status
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

    req.customer = result.rows[0];

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

module.exports = {
  authenticateCustomer,
};