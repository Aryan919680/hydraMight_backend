const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

const router = express.Router();

/**
 * NOTE:
 * This is simple custom login using user_profiles.
 * In Supabase production, you can also use Supabase Auth OTP/password login.
 *
 * For this plain Express backend MVP, create admin/customer records manually
 * or via Supabase auth.users and user_profiles.
 */

// Basic profile login by email + password_hash.
// Add this column if using this route:
// alter table user_profiles add column if not exists password_hash text;
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const result = await db.query(
      `select id, full_name, email, mobile, user_type, status, password_hash
       from user_profiles
       where email = $1
       limit 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid login credentials' });
    }

    const user = result.rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'User is not active' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ success: false, message: 'Password login not configured for this user' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid login credentials' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        user_type: user.user_type
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );

    delete user.password_hash;

    res.json({
      success: true,
      token,
      user
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// Temporary helper to create an admin profile password.
// Use only for local/dev setup. Remove in production.
router.post('/setup-password', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `update user_profiles
       set password_hash = $1, updated_at = now()
       where email = $2
       returning id, full_name, email, user_type, status`,
      [passwordHash, email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User profile not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Setup password error:', error);
    res.status(500).json({ success: false, message: 'Password setup failed' });
  }
});

module.exports = router;
