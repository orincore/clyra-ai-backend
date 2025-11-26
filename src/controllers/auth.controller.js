import jwt from 'jsonwebtoken';
import { promisify } from 'util';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import { userDB } from '../config/supabaseClient.js';
import AppError from '../utils/appError.js';
import env from '../config/env.js';
import { uploadToS3, deleteFromS3, getKeyFromUrl } from '../config/s3.js';
import path from 'path';
import { redisClient } from '../config/redis.js';
import { supabaseAdmin } from '../config/supabaseClient.js';

const signToken = (id) => {
  return jwt.sign({ id }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
};

// isWhatsappGatewayReady is defined below near OTP helpers

// Step 1 (WhatsApp): user submits their phone to receive an OTP (public)
export const sendForgotPasswordWhatsappOtp = async (req, res, next) => {
  try {
    const { contactNumber } = req.body || {};
    if (!contactNumber) return next(new AppError('contactNumber is required', 400));

    // Check gateway readiness (informational)
    const ready = await isWhatsappGatewayReady();
    if (!ready) {
      return res.status(200).json({ status: 'success', message: 'WhatsApp verification unavailable. Please try email method.' });
    }

    // Attempt to send OTP regardless of user existence to avoid format mismatches.
    // Still avoid enumeration by returning a generic response.
    try {
      const payload = { contactNumber, reason: 'Password reset', appName: OTP_APP_NAME };
      const { data } = await axios.post(`${OTP_BASE_URL}/api/otp/send`, payload, { timeout: 8000, headers: { 'x-api-key': OTP_API_KEY } });
      if (data?.success && data?.uuid) {
        const ttl = (typeof data.expiresIn === 'number' && data.expiresIn > 0) ? data.expiresIn : 300;
        // Try to resolve user now and store userId to avoid format mismatches later
        const variants = (() => {
          const raw = String(contactNumber).trim();
          const digits = raw.replace(/[^0-9]/g, '');
          const set = new Set([raw]);
          if (raw.startsWith('+')) set.add(raw.slice(1));
          if (digits.length === 10) set.add(`+91${digits}`);
          if (raw.startsWith('0') && digits.length >= 10) set.add(`+91${digits.replace(/^0+/, '')}`);
          set.add(digits);
          return Array.from(set).filter(Boolean);
        })();

        let resolvedUser = null;
        for (const v of variants) {
          try {
            resolvedUser = await userDB.findUserByIdentifier(v);
            if (resolvedUser) break;
          } catch (_) { /* continue */ }
        }
        if (!resolvedUser) {
          const digits = String(contactNumber).replace(/[^0-9]/g, '');
          const last10 = digits.slice(-10);
          const last7 = digits.slice(-7);
          if (last10) {
            const { data: candidates } = await supabaseAdmin
              .from('user_profiles')
              .select('id, phone_number, email')
              .or(`phone_number.ilike.%${last10},phone_number.ilike.%${last7}`)
              .limit(1);
            if (Array.isArray(candidates) && candidates.length > 0) {
              resolvedUser = candidates[0];
            }
          }
        }

        // Store session by phone for public flow
        const key = `pwd_whatsapp_public_phone:${contactNumber}`;
        await redisClient.del(key);
        const value = JSON.stringify({ uuid: data.uuid, contactNumber, reason: 'Password reset', userId: resolvedUser?.id || null });
        await redisClient.set(key, value, ttl);
      }
    } catch (e) {
      console.warn('[forgot-password-wa] Failed to send WhatsApp OTP:', e?.message || e);
    }

    return res.status(200).json({ status: 'success', message: 'If an account with that number exists, a reset code has been sent via WhatsApp.' });
  } catch (error) {
    next(error);
  }
};

// Step 2 (WhatsApp): user submits phone + otp + newPassword to reset (public)
export const confirmForgotPasswordWhatsappOtp = async (req, res, next) => {
  try {
    const { contactNumber, otp, newPassword, uuid } = req.body || {};
    if (!contactNumber) return next(new AppError('contactNumber is required', 400));
    if (!otp) return next(new AppError('OTP is required', 400));
    if (!newPassword || String(newPassword).length < 8) {
      return next(new AppError('newPassword must be at least 8 characters long', 400));
    }

    // First validate OTP session so we can provide precise error if code is wrong/expired
    const buildVariants = () => {
      const raw = String(contactNumber).trim();
      const digits = raw.replace(/[^0-9]/g, '');
      const set = new Set([raw]);
      if (raw.startsWith('+')) set.add(raw.slice(1));
      if (digits.length === 10) set.add(`+91${digits}`);
      if (raw.startsWith('0') && digits.length >= 10) set.add(`+91${digits.replace(/^0+/, '')}`);
      set.add(digits);
      return Array.from(set).filter(Boolean);
    };

    // Try to fetch OTP session using several phone variants
    const variantsForKeys = buildVariants();
    let phoneKeyUsed = null;
    let cachedRaw = null;
    for (const v of variantsForKeys) {
      const k = `pwd_whatsapp_public_phone:${v}`;
      // eslint-disable-next-line no-await-in-loop
      const val = await redisClient.get(k);
      if (val) {
        phoneKeyUsed = k;
        cachedRaw = val;
        break;
      }
    }
    // Legacy fallback key requires user id; we'll try it after finding user
    const cachedPhone = cachedRaw ? JSON.parse(cachedRaw) : null;
    const candidateUuid = uuid || cachedPhone?.uuid;
    if (!candidateUuid) {
      // We don't yet know userId; try to find it to check legacy key
      // Continue; after user lookup we'll retry reading the legacy key
    }

    let otpVerified = false;
    if (candidateUuid) {
      try {
        const verifyUrl = `${OTP_BASE_URL}/api/otp/verify`;
        const { data } = await axios.get(verifyUrl, { params: { uuid: candidateUuid, contactNumber, otp }, timeout: 8000, headers: { 'x-api-key': OTP_API_KEY } });
        otpVerified = !!data?.success;
      } catch (_) { otpVerified = false; }
    }

    // If session contains a userId, prefer that
    let user = null;
    if (cachedPhone?.userId) {
      try {
        user = await userDB.getUserById(cachedPhone.userId);
      } catch (_) { user = null; }
    }

    // Now find the user by multiple phone variants to avoid formatting issues
    const variants = (() => {
      const raw = String(contactNumber).trim();
      const digits = raw.replace(/[^0-9]/g, '');
      const list = new Set([raw]);
      if (raw.startsWith('+')) list.add(raw.slice(1));
      if (digits.length === 10) list.add(`+91${digits}`);
      if (raw.startsWith('0') && digits.length >= 10) list.add(`+91${digits.replace(/^0+/, '')}`);
      list.add(digits);
      return Array.from(list).filter(Boolean);
    })();

    for (const v of variants) {
      try {
        if (!user) {
          user = await userDB.findUserByIdentifier(v);
        }
        if (user) break;
      } catch (_) { /* continue */ }
    }

    // If not found, try suffix match on last 7-10 digits
    if (!user) {
      const digits = String(contactNumber).replace(/[^0-9]/g, '');
      const last10 = digits.slice(-10);
      const last7 = digits.slice(-7);
      if (last10) {
        const { data: candidates } = await supabaseAdmin
          .from('user_profiles')
          .select('*')
          .or(`phone_number.ilike.%${last10},phone_number.ilike.%${last7}`)
          .limit(1);
        if (Array.isArray(candidates) && candidates.length > 0) {
          user = candidates[0];
        }
      }
    }

    // If OTP wasn't verified earlier and we have a legacy user-keyed session, retry verification now
    if (!otpVerified && user) {
      const userKey = `pwd_whatsapp_public:${user.id}`;
      const legacyRaw = await redisClient.get(userKey);
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw);
        const finalUuid = uuid || legacy.uuid;
        if (finalUuid) {
          const verifyUrl = `${OTP_BASE_URL}/api/otp/verify`;
          const { data } = await axios.get(verifyUrl, { params: { uuid: finalUuid, contactNumber, otp }, timeout: 8000, headers: { 'x-api-key': OTP_API_KEY } });
          otpVerified = !!data?.success;
        }
      }
    }

    if (!otpVerified) return next(new AppError('Invalid or expired OTP.', 400));
    if (!user) return next(new AppError('Invalid contact or code.', 400));

    // Update password
    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(String(newPassword), salt);
    const updated = await userDB.updateProfile(user.id, { password: hash, password_changed_at: new Date() });
    const userKey = `pwd_whatsapp_public:${user.id}`;
    await Promise.all([
      redisClient.del(phoneKeyUsed || `pwd_whatsapp_public_phone:${contactNumber}`),
      redisClient.del(userKey)
    ]);

    // Security alert email (best-effort)
    if (env.SECURITY_ALERTS_ENABLED) {
      try {
        const ip = extractClientIp(req);
        const location = await resolveIpLocation(ip);
        const ua = req.headers['user-agent'] || '';
        const whenISO = new Date().toISOString();
        const { subject, text, html } = buildSecurityAlertEmail({ type: 'password_reset', name: user.first_name || 'there', appName: env.APP_NAME, ip, userAgent: ua, whenISO, location });
        await sendEmail({ to: user.email, subject, text, html });
      } catch (e) {
        console.warn('[security-email] Failed to send password reset alert (public whatsapp):', e?.message || e);
      }
    }

    return res.status(200).json({ status: 'success', message: 'Password reset successfully.', data: { user: updated } });
  } catch (error) {
    next(error);
  }
};

// ===================== Public forgot-password via email (no auth) =====================
// Step 1: user submits their email to receive an OTP
export const sendForgotPasswordEmailOtp = async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) return next(new AppError('email is required', 400));

    // Email-based password reset is disabled; always return success without sending any email
    return res.status(200).json({ status: 'success', message: 'Password reset via email is currently disabled.' });
  } catch (error) {
    next(error);
  }
};

// Step 2: user submits email + otp + newPassword to reset
export const confirmForgotPasswordEmailOtp = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    if (!email) return next(new AppError('email is required', 400));
    if (!otp) return next(new AppError('OTP is required', 400));
    if (!newPassword || String(newPassword).length < 8) {
      return next(new AppError('newPassword must be at least 8 characters long', 400));
    }
    // Email-based password reset is disabled
    return res.status(400).json({ status: 'fail', message: 'Password reset via email is currently disabled.' });
  } catch (error) {
    next(error);
  }
};

// ============ Phone (WhatsApp) OTP via external OTP service ============
const OTP_BASE_URL = process.env.OTP_BASE_URL || 'https://otp.orincore.com';
const OTP_API_KEY = process.env.OTP_API_KEY || '';

// ============ IP utilities ============
const extractClientIp = (req) => {
  const xf = req.headers['x-forwarded-for'];
  if (xf && typeof xf === 'string') {
    // x-forwarded-for can be a list: client, proxy1, proxy2
    const first = xf.split(',')[0]?.trim();
    return first || req.ip || '';
  }
  if (Array.isArray(xf) && xf.length > 0) {
    return xf[0] || req.ip || '';
  }
  return (req.ip || '').toString();
};

const resolveIpLocation = async (ip) => {
  try {
    if (!ip) return '';
    // Skip local/private ranges
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(ip) || ip === '::1') {
      return '';
    }
    const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const { data } = await axios.get(url, { timeout: 5000 });
    if (!data || data.error) return '';
    const parts = [data.city, data.region, data.country_name].filter(Boolean);
    return parts.join(', ');
  } catch (_) {
    return '';
  }
};

const OTP_APP_NAME = env.APP_NAME || 'Clyra AI';

async function isWhatsappGatewayReady() {
  try {
    const url = `${OTP_BASE_URL}/api/whatsapp/status`;
    const { data } = await axios.get(url, { timeout: 5000, headers: { 'x-api-key': OTP_API_KEY } });
    return !!(data?.success && data?.status?.isReady && data?.status?.authenticated === true);
  } catch (e) {
    console.warn('[otp] WhatsApp status check failed:', e?.message || e);
    return false;
  }
}

// Decide whether full account verification should be marked based on channel states
async function computeAndApplyFullVerification(userId) {
  // Load fresh
  const user = await userDB.getUserById(userId);
  if (!user) throw new AppError('User not found', 404);

  const hasPhone = !!user.phone_number;
  const gatewayReady = await isWhatsappGatewayReady();

  // If phone is present and gateway is ready, require BOTH email and phone
  const requirePhone = hasPhone && gatewayReady;
  const emailOk = !!user.is_email_verified || !!user.is_verified; // backward compatibility
  const phoneOk = !!user.is_phone_verified;

  const shouldBeVerified = emailOk && (!requirePhone || phoneOk);

  if (shouldBeVerified && !user.is_verified) {
    const updated = await userDB.updateProfile(userId, { is_verified: true, verified_at: new Date() });
    return updated;
  }
  // If not verified yet, return latest user
  return user;
}

// Send phone OTP (WhatsApp). Only proceeds if gateway is ready; otherwise instructs to use email verification.
export const sendPhoneVerification = async (req, res, next) => {
  try {
    const user = await userDB.getUserById(req.user.id);
    if (!user) return next(new AppError('User not found', 404));

    const ready = await isWhatsappGatewayReady();
    if (!ready) {
      return res.status(200).json({
        status: 'success',
        message: 'WhatsApp verification unavailable. Please verify via email.',
        data: { whatsapp_ready: false }
      });
    }

    const contactNumber = req.body?.contactNumber || user.phone_number;
    if (!contactNumber) {
      return next(new AppError('contactNumber is required to send OTP', 400));
    }

    const payload = {
      contactNumber,
      reason: 'account_verification',
      appName: OTP_APP_NAME
    };

    const { data } = await axios.post(`${OTP_BASE_URL}/api/otp/send`, payload, { timeout: 8000, headers: { 'x-api-key': OTP_API_KEY } });
    if (!data?.success || !data?.uuid) {
      return next(new AppError('Failed to send OTP. Please try again later.', 502));
    }

    // Store mapping in Redis with TTL returned by API (fallback 5m)
    const ttl = (typeof data.expiresIn === 'number' && data.expiresIn > 0) ? data.expiresIn : 300;
    const key = `phone_verif:${req.user.id}`;
    await redisClient.del(key);
    const value = JSON.stringify({ uuid: data.uuid, contactNumber, reason: 'account_verification' });
    const ok = await redisClient.set(key, value, ttl);
    if (!ok) {
      return next(new AppError('Failed to persist OTP session. Please retry.', 500));
    }

    res.status(200).json({
      status: 'success',
      message: 'OTP sent via WhatsApp',
      data: { uuid: data.uuid, contactNumber, expiresIn: ttl }
    });
  } catch (error) {
    next(error);
  }
};

// Send password reset OTP via chosen method: 'email' or 'phone'
export const sendPasswordResetOtp = async (req, res, next) => {
  try {
    const { method, contactNumber } = req.body || {};
    const user = await userDB.getUserById(req.user.id);
    if (!user) return next(new AppError('User not found', 404));

    if (method === 'phone') {
      const ready = await isWhatsappGatewayReady();
      if (!ready) {
        return res.status(200).json({ status: 'success', message: 'WhatsApp unavailable. Choose email method.', data: { whatsapp_ready: false } });
      }
      const number = contactNumber || user.phone_number;
      if (!number) return next(new AppError('contactNumber is required for phone method', 400));

      const payload = { contactNumber: number, reason: 'Password reset', appName: OTP_APP_NAME };
      const { data } = await axios.post(`${OTP_BASE_URL}/api/otp/send`, payload, { timeout: 8000, headers: { 'x-api-key': OTP_API_KEY } });
      if (!data?.success || !data?.uuid) return next(new AppError('Failed to send OTP. Please try again later.', 502));

      const ttl = (typeof data.expiresIn === 'number' && data.expiresIn > 0) ? data.expiresIn : 300;
      const key = `phone_pwd:${req.user.id}`;
      await redisClient.del(key);
      const value = JSON.stringify({ uuid: data.uuid, contactNumber: number, reason: 'Password reset' });
      const ok = await redisClient.set(key, value, ttl);
      if (!ok) return next(new AppError('Failed to persist OTP session. Please retry.', 500));

      return res.status(200).json({ status: 'success', message: 'Password reset OTP sent via WhatsApp', data: { uuid: data.uuid, contactNumber: number, expiresIn: ttl } });
    }

    // Email-based password reset codes are disabled
    return res.status(400).json({ status: 'fail', message: 'Password reset via email is currently disabled.' });
  } catch (error) {
    next(error);
  }
};

// Confirm password reset with OTP via chosen method
export const confirmPasswordResetOtp = async (req, res, next) => {
  try {
    const { method, otp, uuid, contactNumber, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return next(new AppError('newPassword must be at least 8 characters long', 400));
    }
    const user = await userDB.getUserById(req.user.id);
    if (!user) return next(new AppError('User not found', 404));

    if (method === 'phone') {
      const key = `phone_pwd:${req.user.id}`;
      const cachedRaw = await redisClient.get(key);
      if (!cachedRaw) return next(new AppError('OTP session expired or not found. Please request a new code.', 400));
      const cached = JSON.parse(cachedRaw);
      const finalUuid = uuid || cached.uuid;
      const finalContact = contactNumber || cached.contactNumber || user.phone_number;
      if (!finalUuid || !finalContact) return next(new AppError('Invalid verification session. Please resend OTP.', 400));

      if (!otp) return next(new AppError('otp is required', 400));
      const verifyUrl = `${OTP_BASE_URL}/api/otp/verify`;
      const { data } = await axios.get(verifyUrl, { params: { uuid: finalUuid, contactNumber: finalContact, otp }, timeout: 8000, headers: { 'x-api-key': OTP_API_KEY } });
      if (!data?.success) return next(new AppError('Invalid or expired OTP.', 400));

      // Update password
      const salt = await bcrypt.genSalt(12);
      const hash = await bcrypt.hash(String(newPassword), salt);
      const updated = await userDB.updateProfile(user.id, { password: hash, password_changed_at: new Date() });
      await redisClient.del(key);
      return res.status(200).json({ status: 'success', message: 'Password reset successfully.', data: { user: updated } });
    }

    // Email-based password reset confirmation is disabled
    return res.status(400).json({ status: 'fail', message: 'Password reset via email is currently disabled.' });
  } catch (error) {
    next(error);
  }
};

// Confirm phone OTP.
export const verifyPhoneOtp = async (req, res, next) => {
  try {
    const user = await userDB.getUserById(req.user.id);
    if (!user) return next(new AppError('User not found', 404));

    const { otp, uuid, contactNumber } = req.body || {};
    if (!otp) return next(new AppError('otp is required', 400));

    // Load stored session
    const key = `phone_verif:${req.user.id}`;
    const cachedRaw = await redisClient.get(key);
    if (!cachedRaw) {
      return next(new AppError('OTP session expired or not found. Please request a new code.', 400));
    }
    const cached = JSON.parse(cachedRaw);

    const finalUuid = uuid || cached.uuid;
    const finalContact = contactNumber || cached.contactNumber || user.phone_number;
    if (!finalUuid || !finalContact) {
      return next(new AppError('Invalid verification session. Please resend OTP.', 400));
    }

    // Verify via external service (GET with params)
    const verifyUrl = `${OTP_BASE_URL}/api/otp/verify`;
    const { data } = await axios.get(verifyUrl, {
      params: { uuid: finalUuid, contactNumber: finalContact, otp },
      timeout: 8000,
      headers: { 'x-api-key': OTP_API_KEY }
    });

    if (!data?.success) {
      return next(new AppError('Invalid or expired OTP.', 400));
    }

    // Mark phone channel verified
    await userDB.updateProfile(user.id, { is_phone_verified: true });
    await redisClient.del(key);

    // Compute overall verification according to rules
    const updated = await computeAndApplyFullVerification(user.id);
    res.status(200).json({
      status: 'success',
      message: 'Phone verified successfully',
      data: { user: updated, verifiedFor: data.verifiedFor || 'account_verification' }
    });
  } catch (error) {
    next(error);
  }
};

// Generate a 6-digit OTP
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

// Send verification OTP to current user's email
export const sendEmailVerification = async (req, res, next) => {
  try {
    const user = await userDB.getUserById(req.user.id);
    if (!user) return next(new AppError('User not found', 404));

    // Email verification flow is disabled
    res.status(200).json({ status: 'success', message: 'Email verification is disabled.' });
  } catch (error) {
    next(error);
  }
};

// Verify email with OTP
export const verifyEmailOtp = async (req, res, next) => {
  try {
    const { otp } = req.body || {};
    if (!otp) return next(new AppError('OTP is required', 400));

    const user = await userDB.getUserById(req.user.id);
    if (!user) return next(new AppError('User not found', 404));

    // Email verification confirmation is disabled
    res.status(200).json({ status: 'success', message: 'Email verification is disabled.' });
  } catch (error) {
    next(error);
  }
};

// Delete current user's avatar: remove from S3 and clear avatar_url
export const deleteAvatar = async (req, res, next) => {
  try {
    const user = await userDB.getUserById(req.user.id);
    if (!user) return next(new AppError('User not found', 404));

    const prevUrl = user.avatar_url;
    if (!prevUrl) {
      return res.status(200).json({ status: 'success', data: { avatar_url: null, deleted: false } });
    }

    // Try to delete object from S3
    try {
      const prevKey = getKeyFromUrl(prevUrl);
      if (prevKey) {
        await deleteFromS3({ Key: prevKey });
      }
    } catch (e) {
      console.warn('[avatar] Failed to delete avatar from S3:', e?.message || e);
    }

    // Clear field in profile
    const updated = await userDB.updateProfile(req.user.id, { avatar_url: null });
    return res.status(200).json({ status: 'success', data: { avatar_url: null, user: updated, deleted: true } });
  } catch (error) {
    next(error);
  }
};

const createSendToken = (user, statusCode, res) => {
  const token = signToken(user.id);
  const cookieOptions = {
    expires: new Date(
      Date.now() + env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  };

  res.cookie('jwt', token, cookieOptions);

  // Remove password from output
  user.password = undefined;

  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user,
    },
  });
};

export const signup = async (req, res, next) => {
  try {
    const { email, password, username, phone_number, first_name, last_name, gender, age } = req.body;

    // 1) Validate required fields
    if (!email || !password || !username || !first_name || !last_name) {
      return next(new AppError('Please provide all required fields', 400));
    }

    // 2) Check if user exists
    const existingUser = await userDB.findUserByIdentifier(email) || 
                         await userDB.findUserByIdentifier(username) ||
                         (phone_number ? await userDB.findUserByIdentifier(phone_number) : null);

    if (existingUser) {
      return next(new AppError('User with this email/username/phone already exists', 400));
    }

    // 3) Create user in Supabase Auth and user_profiles
    const { user, profile, error } = await userDB.signUpWithEmail(email, password, {
      username,
      first_name,
      last_name,
      phone_number,
      gender,
      age: parseInt(age, 10)
    });

    if (error) {
      return next(new AppError(error.message || 'Error creating user', 500));
    }

    // 4) Ensure user starts unverified until OTP confirmation
    try {
      await userDB.updateProfile(user.id, { is_verified: false });
    } catch (e) {
      console.warn('[signup] Failed to set is_verified=false:', e?.message || e);
    }

    // 5) Fetch latest profile and respond
    const latest = await userDB.getUserById(user.id);
    createSendToken({
      id: user.id,
      email: user.email,
      ...latest
    }, 201, res);
  } catch (error) {
    next(error);
  }
};

// Upload avatar image to S3 and save URL on user profile
export const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) {
      return next(new AppError('No file uploaded. Expected field "avatar"', 400));
    }

    const file = req.file;
    // Get current user to check existing avatar
    const currentUser = await userDB.getUserById(req.user.id);

    // Build a safe S3 object key
    const ext = path.extname(file.originalname || '.jpg').toLowerCase();
    const filename = `${Date.now()}${ext}`;
    const key = `avatars/${req.user.id}/${filename}`;

    // Upload to S3
    const result = await uploadToS3({
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        originalname: file.originalname,
        uploadedBy: req.user.id,
      },
    });

    // Get the public URL from the result
    const avatarUrl = result.url || result;
    
    if (!avatarUrl) {
      throw new Error('Failed to generate avatar URL');
    }

    // Save the new avatar URL
    const updatedUser = await userDB.updateProfile(req.user.id, { 
      avatar_url: avatarUrl 
    });

    // Best-effort: delete previous avatar if it exists and is different
    try {
      const prevUrl = currentUser?.avatar_url;
      if (prevUrl && prevUrl !== avatarUrl) {
        const prevKey = getKeyFromUrl(prevUrl);
        if (prevKey && typeof prevKey === 'string' && prevKey !== key) {
          await deleteFromS3({ Key: prevKey }).catch(e => 
            console.warn('[avatar] Failed to delete old avatar:', e?.message || e)
          );
        }
      }
    } catch (e) {
      // Log and continue; not fatal
      console.warn('[avatar] Failed to clean up previous avatar:', e?.message || e);
    }

    res.status(200).json({
      status: 'success',
      data: {
        user: updatedUser,
        avatar_url: avatarUrl,
      },
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    next(error);
  }
};

export const login = async (req, res, next) => {
  try {
    const { identifier, password } = req.body;

    // 1) Check if identifier and password exist
    if (!identifier || !password) {
      return next(new AppError('Please provide identifier and password!', 400));
    }

    // 2) Find user by identifier (email/username/phone)
    const user = await userDB.findUserByIdentifier(identifier);
    if (!user || !user.password) {
      return next(new AppError('Incorrect email/username/phone or password', 401));
    }

    // 2.5) Check if account is deactivated (soft deleted)
    if (user.hasOwnProperty('is_active') && user.is_active === false) {
      return next(new AppError('This account is closed. Please contact support to reopen.', 403));
    }

    // 3) Check if password is correct
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return next(new AppError('Incorrect email/username/phone or password', 401));
    }

    // 4) Update last login
    await userDB.updateProfile(user.id, { last_login: new Date() });

    // 4.5) Send login security alert (best-effort)
    if (env.SECURITY_ALERTS_ENABLED) {
      try {
        const ip = extractClientIp(req);
        const location = await resolveIpLocation(ip);
        const ua = req.headers['user-agent'] || '';
        const whenISO = new Date().toISOString();
        const { subject, text, html } = buildSecurityAlertEmail({ type: 'login', name: user.first_name || 'there', appName: env.APP_NAME, ip, userAgent: ua, whenISO, location });
        await sendEmail({ to: user.email, subject, text, html });
      } catch (e) {
        console.warn('[security-email] Failed to send login alert:', e?.message || e);
      }
    }

    // 5) Send token to client
    createSendToken({
      id: user.id,
      email: user.email,
      ...user
    }, 200, res);
  } catch (error) {
    next(error);
  }
};

// Get current user's data
export const getCurrentUser = async (req, res, next) => {
  try {
    // User is already attached to req by protect middleware
    const user = await userDB.getUserById(req.user.id);
    
    if (!user) {
      return next(new AppError('User not found', 404));
    }

    res.status(200).json({
      status: 'success',
      data: {
        user
      }
    });
  } catch (error) {
    next(error);
  }
};

// Update user data
export const updateUser = async (req, res, next) => {
  try {
    // Filter out unwanted field names that are not allowed to be updated
    const filteredBody = {};
    const allowedFields = ['first_name', 'last_name', 'email', 'phone_number', 'gender', 'age', 'username'];
    
    Object.keys(req.body).forEach(key => {
      if (allowedFields.includes(key)) {
        filteredBody[key] = req.body[key];
      }
    });

    // If updating password, hash it first
    if (req.body.password) {
      const salt = await bcrypt.genSalt(12);
      filteredBody.password = await bcrypt.hash(req.body.password, salt);
    }

    const updatedUser = await userDB.updateProfile(req.user.id, filteredBody);

    if (!updatedUser) {
      return next(new AppError('User not found', 404));
    }

    res.status(200).json({
      status: 'success',
      data: {
        user: updatedUser
      }
    });
  } catch (error) {
    next(error);
  }
};

// Delete user account
export const deleteUser = async (req, res, next) => {
  try {
    // Require password confirmation in payload
    const { password } = req.body || {};
    if (!password) {
      return next(new AppError('Password is required to close the account.', 400));
    }

    // Fetch latest user to check password
    const user = await userDB.getUserById(req.user.id);
    if (!user || !user.password) {
      return next(new AppError('User not found', 404));
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return next(new AppError('Incorrect password', 401));
    }

    // Soft delete: deactivate the user instead of deleting their data
    const updated = await userDB.updateProfile(req.user.id, { is_active: false });

    // Clear the JWT cookie
    res.cookie('jwt', 'loggedout', {
      expires: new Date(Date.now() + 10 * 1000),
      httpOnly: true
    });

    res.status(200).json({
      status: 'success',
      message: 'Account has been closed. You can contact support to reopen it.',
      data: { user: updated }
    });
  } catch (error) {
    next(error);
  }
};

export const protect = async (req, res, next) => {
  try {
    // 1) Getting token and check if it's there
    let token;
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies.jwt) {
      token = req.cookies.jwt;
    }

    if (!token) {
      return next(
        new AppError('You are not logged in! Please log in to get access.', 401)
      );
    }

    // 2) Verify token
    const decoded = await promisify(jwt.verify)(token, env.JWT_SECRET);

    // 3) Check if user still exists in Supabase
    const currentUser = await userDB.getUserById(decoded.id);
    if (!currentUser) {
      return next(new AppError('The user belonging to this token no longer exists.', 401));
    }

    // 3.5) Block access if the account is deactivated (soft deleted)
    if (currentUser.hasOwnProperty('is_active') && currentUser.is_active === false) {
      return next(new AppError('This account is closed. Please contact support to reopen.', 403));
    }

    // 4) Check if user changed password after the token was issued
    if (currentUser.password_changed_at) {
      const changedTimestamp = parseInt(
        new Date(currentUser.password_changed_at).getTime() / 1000,
        10
      );

      if (decoded.iat < changedTimestamp) {
        return next(
          new AppError('User recently changed password! Please log in again.', 401)
        );
      }
    }

    // GRANT ACCESS TO PROTECTED ROUTE
    req.user = currentUser;
    res.locals.user = currentUser;
    next();
  } catch (error) {
    next(error);
  }
};
