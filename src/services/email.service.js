import nodemailer from 'nodemailer';
import env from '../config/env.js';

let transporter;

function getTransporter() {
  if (!transporter) {
    const port = Number(env.SMTP_PORT || 587);
    const secure = port === 465; // Zoho and many providers use 465 for implicit TLS

    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
      // Connection pool can improve throughput and stability
      pool: true,
      maxConnections: 2,
      tls: {
        // Allow STARTTLS; most providers require a valid cert, keep default strictness
        // rejectUnauthorized: false,
      },
    });

    // Best-effort verification to surface auth/config issues early
    transporter.verify().then(() => {
      console.log('[mailer] SMTP transporter verified');
    }).catch((e) => {
      console.warn('[mailer] SMTP verify failed:', e?.message || e);
    });
  }
  return transporter;
}

export function buildNudgeEmail({
  name = 'there',
  characterName = 'Your character',
  appName = 'Clyra AI',
  ctaUrl = '',
  previewText = 'You have a new message waiting.'
}) {
  const subject = `${characterName} pinged you on ${appName}`;
  const text = `Hi ${name},\n\n${characterName} left you a message. Open ${appName} to read it.\n\n${ctaUrl ? `Open: ${ctaUrl}` : ''}`;
  const ctaHtml = ctaUrl ? `
    <table align="center" role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 8px;">
      <tr>
        <td align="center" bgcolor="#6C5CE7" style="border-radius:12px;">
          <a href="${ctaUrl}" style="display:inline-block; padding:12px 18px; color:#FFFFFF; font-weight:700; font-family:Segoe UI,Roboto,Arial,sans-serif; text-decoration:none;">Open Chat</a>
        </td>
      </tr>
    </table>
  ` : '';
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <title>${appName} • New Ping</title>
    <style>
      body,table,td,a{ -ms-text-size-adjust:100%; -webkit-text-size-adjust:100%; }
      table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }
      img{ -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
      table{ border-collapse:collapse !important; }
      body{ margin:0 !important; padding:0 !important; width:100% !important; height:100% !important; background-color:#0E0B1F; }
      a { color: #6C5CE7; text-decoration: none; }
      @media screen and (max-width:600px){ .container{ width:100% !important; } .px{ padding-left:20px !important; padding-right:20px !important; } }
    </style>
  </head>
  <body style="background-color:#0E0B1F;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${previewText}</div>
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table class="container" border="0" cellpadding="0" cellspacing="0" role="presentation" width="640" style="width:640px; max-width:640px;">
            <tr>
              <td style="background:#15122A; border-radius:16px; box-shadow:0 12px 32px rgba(24,16,80,.35);">
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:linear-gradient(135deg,#6C5CE7,#4B43BD); padding:28px 28px; border-top-left-radius:16px;border-top-right-radius:16px;">
                      <table width="100%" role="presentation">
                        <tr>
                          <td align="left" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:22px; font-weight:800; color:#FFFFFF; letter-spacing:.3px;">
                            ${appName}
                          </td>
                          <td align="right" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:12px; color:#F3F2FF;">
                            New Ping
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="height:1px; background:linear-gradient(90deg, rgba(108,92,231,.0), rgba(108,92,231,.45), rgba(108,92,231,.0));"></td>
                  </tr>
                </table>
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td class="px" style="padding:28px; font-family:Segoe UI,Roboto,Arial,sans-serif;">
                      <p style="margin:0 0 10px; color:#B8B5D8; font-size:16px;">Hi ${name},</p>
                      <h2 style="margin:0 0 12px; color:#FFFFFF; font-size:22px; font-weight:800;">${characterName} left you a message</h2>
                      <p style="margin:0 0 18px; color:#D7D4F3; font-size:15px; line-height:1.6;">Open your chats to see what they said. They’re waiting for you. **smiles**</p>
                      ${ctaHtml}
                    </td>
                  </tr>
                </table>
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:18px 28px 26px; border-top:1px solid rgba(255,255,255,.06); font-family:Segoe UI,Roboto,Arial,sans-serif; color:#A8A5C9; font-size:12px;">
                      <div style="margin:0 0 4px;">&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
  return { subject, text, html };
}

export async function sendEmail({ to, subject, text, html }) {
  const tx = getTransporter();
  // Many providers (incl. Brevo) require From to be a verified/sender address
  // Force default From to SMTP_USER to avoid silent drops
  const from = env.SMTP_FROM || env.SMTP_USER;
  if (env.SMTP_FROM && env.SMTP_FROM !== env.SMTP_USER) {
    console.warn('[mailer] Using custom SMTP_FROM. Ensure this sender is verified in your SMTP provider to avoid spam/drops:', env.SMTP_FROM);
  }

  const toList = Array.isArray(to) ? to : [to];
  console.log('[mailer] Preparing to send email', {
    to: toList,
    subject
  });

  const info = await tx.sendMail({
    from,
    to: toList,
    subject,
    text,
    html,
    envelope: {
      from: env.SMTP_USER,
      to: toList,
    },
  });
  try {
    console.log('Email sent! MessageId:', info?.messageId || '(unknown)');
    if (info?.accepted?.length) {
      console.log('Accepted:', info.accepted.join(', '));
    }
    if (info?.response) {
      console.log('SMTP response:', info.response);
    }
  } catch (_) {}
  return info;
}

export function buildOtpEmail({ name = 'there', otp, minutes = 10, appName = 'Clyra AI', ctaUrl = '', supportEmail = 'contact@orincore.com' }) {
  const subject = `${appName}: Your verification code`;
  const text = `Hi ${name},\n\nYour ${appName} verification code is ${otp}. It expires in ${minutes} minutes.\n\nIf you did not request this, you can ignore this email.\n\nSent by Verification Team\n— Orincore Technologies\nAdarsh Suradkar, CEO & Lead Developer`;
  const ctaHtml = ctaUrl ? `
    <table align="center" role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 8px;">
      <tr>
        <td align="center" bgcolor="#6C5CE7" style="border-radius:12px;">
          <a href="${ctaUrl}" style="display:inline-block; padding:12px 18px; color:#FFFFFF; font-weight:700; font-family:Segoe UI,Roboto,Arial,sans-serif; text-decoration:none;">Open ${appName}</a>
        </td>
      </tr>
    </table>
  ` : '';
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <title>${appName} • Verification Code</title>
    <style>
      /* Client resets */
      body,table,td,a{ -ms-text-size-adjust:100%; -webkit-text-size-adjust:100%; }
      table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }
      img{ -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
      table{ border-collapse:collapse !important; }
      body{ margin:0 !important; padding:0 !important; width:100% !important; height:100% !important; background-color:#0E0B1F; }
      a { color: #6C5CE7; text-decoration: none; }
      /* Mobile */
      @media screen and (max-width:600px){
        .container{ width:100% !important; }
        .px{ padding-left:20px !important; padding-right:20px !important; }
        .otp-digit{ width:44px !important; height:54px !important; font-size:20px !important; }
      }
    </style>
  </head>
  <body style="background-color:#0E0B1F;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Your ${appName} verification code is ${otp}. Expires in ${minutes} minutes.
    </div>
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table class="container" border="0" cellpadding="0" cellspacing="0" role="presentation" width="640" style="width:640px; max-width:640px;">
            <!-- Card -->
            <tr>
              <td style="background:#15122A; border-radius:16px; box-shadow:0 12px 32px rgba(24,16,80,.35);">
                <!-- Header -->
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:linear-gradient(135deg,#6C5CE7,#4B43BD); padding:28px 28px; border-top-left-radius:16px;border-top-right-radius:16px;">
                      <table width="100%" role="presentation">
                        <tr>
                          <td align="left" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:22px; font-weight:800; color:#FFFFFF; letter-spacing:.3px;">
                            ${appName}
                          </td>
                          <td align="right" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:12px; color:#F3F2FF;">
                            Secure Verification
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="height:1px; background:linear-gradient(90deg, rgba(108,92,231,.0), rgba(108,92,231,.45), rgba(108,92,231,.0));"></td>
                  </tr>
                </table>
                <!-- Body -->
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td class="px" style="padding:28px; font-family:Segoe UI,Roboto,Arial,sans-serif;">
                      <p style="margin:0 0 10px; color:#B8B5D8; font-size:16px;">Hi ${name},</p>
                      <h2 style="margin:0 0 12px; color:#FFFFFF; font-size:22px; font-weight:800;">Your verification code</h2>
                      <p style="margin:0 0 20px; color:#D7D4F3; font-size:15px; line-height:1.6;">Use this code to verify your email for ${appName}. For your security, this code expires in <strong>${minutes} minutes</strong>.</p>
                      <!-- OTP -->
                      <table align="center" role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto;">
                        <tr>
                          ${otp.split('').map(d => `
                            <td class="otp-digit" align="center" style="width:52px; height:60px; background:#201C3F; border:1px solid #3A3470; border-radius:12px; box-shadow:0 6px 18px rgba(108,92,231,.25); color:#FFFFFF; font-weight:800; font-size:22px; font-family:Segoe UI,Roboto,Arial,sans-serif; letter-spacing:1px;">
                              ${d}
                            </td>
                            <td style="width:10px; height:1px; font-size:0; line-height:0;">&nbsp;</td>
                          `).join('')}
                        </tr>
                      </table>
                      <!-- Copy-friendly block -->
                      <table align="center" role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:460px; margin:0 auto 18px;">
                        <tr>
                          <td style="background:#1D1840; border:1px dashed #3C3781; border-radius:10px; padding:12px 16px; color:#E9E7FF; font-family:Consolas, SFMono-Regular, Menlo, Monaco, monospace; font-size:18px; text-align:center; letter-spacing:4px;">
                            ${otp}
                          </td>
                        </tr>
                      </table>
                      <p style="margin:6px 0 24px; color:#A9A6C7; font-size:13px; text-align:center;">Didn’t request this? You can safely ignore this email.</p>
                      ${ctaHtml}
                      <p style="margin:10px 0 0; color:#9A97BB; font-size:12px; text-align:center;">Need help? Contact <a href="mailto:${supportEmail}" style="color:#A89BFF; text-decoration:underline;">${supportEmail}</a></p>
                    </td>
                  </tr>
                </table>
                <!-- Footer -->
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:18px 28px 26px; border-top:1px solid rgba(255,255,255,.06); font-family:Segoe UI,Roboto,Arial,sans-serif; color:#A8A5C9; font-size:12px;">
                      <div style="margin:0 0 4px;">&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</div>
                      <div style="margin:0 0 2px; color:#C9C6E6;">Sent by Verification Team</div>
                      <div style="color:#8F8BB5;">By Orincore Technologies — Adarsh Suradkar, CEO & Lead Developer</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
  return { subject, text, html };
}

export function buildSecurityAlertEmail({
  type = 'login', // 'login' | 'password_reset'
  name = 'there',
  appName = 'Clyra AI',
  ip = '',
  userAgent = '',
  whenISO = new Date().toISOString(),
  location = '',
  supportEmail = 'contact@orincore.com'
}) {
  const action = type === 'password_reset' ? 'Password Reset' : 'New Login';
  const subject = `${appName}: ${action} Alert`;
  const text = `Hi ${name},\n\nWe noticed a ${action.toLowerCase()} on your account.\n\nTime: ${whenISO}\nIP: ${ip}\nLocation: ${location || 'Unknown'}\nDevice: ${userAgent || 'Unknown'}\n\nIf this was you, no action is needed. If you don't recognize this activity, please reset your password immediately or contact support at ${supportEmail}.\n\n— The ${appName} Security Team`;
  const manageUrl = env.APP_URL ? `${env.APP_URL.replace(/\/$/, '')}/settings/security` : '';
  const badgeColor = type === 'password_reset' ? '#E67E22' : '#20C997';
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body,table,td,a{ -ms-text-size-adjust:100%; -webkit-text-size-adjust:100%; }
      table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }
      img{ -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
      table{ border-collapse:collapse !important; }
      body{ margin:0 !important; padding:0 !important; width:100% !important; height:100% !important; background-color:#0E0B1F; }
      a { color: #6C5CE7; text-decoration: none; }
      @media screen and (max-width:600px){ .container{ width:100% !important; } .px{ padding-left:20px !important; padding-right:20px !important; } }
    </style>
    <title>${appName} • ${action} Alert</title>
  </head>
  <body style="background-color:#0E0B1F;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${action} alert</div>
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table class="container" border="0" cellpadding="0" cellspacing="0" role="presentation" width="640" style="width:640px; max-width:640px;">
            <tr>
              <td style="background:#15122A; border-radius:16px; box-shadow:0 12px 32px rgba(24,16,80,.35);">
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:linear-gradient(135deg,#6C5CE7,#4B43BD); padding:28px 28px; border-top-left-radius:16px;border-top-right-radius:16px;">
                      <table width="100%" role="presentation">
                        <tr>
                          <td align="left" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:22px; font-weight:800; color:#FFFFFF; letter-spacing:.3px;">${appName}</td>
                          <td align="right" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:12px; color:#F3F2FF;">
                            <span style="display:inline-block; padding:6px 10px; background:${badgeColor}; color:#0E0B1F; border-radius:999px; font-weight:800; letter-spacing:.3px;">${action}</span>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr><td style="height:1px; background:linear-gradient(90deg, rgba(108,92,231,.0), rgba(108,92,231,.45), rgba(108,92,231,.0));"></td></tr>
                </table>
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td class="px" style="padding:28px; font-family:Segoe UI,Roboto,Arial,sans-serif;">
                      <p style="margin:0 0 10px; color:#B8B5D8; font-size:16px;">Hi ${name},</p>
                      <h2 style="margin:0 0 12px; color:#FFFFFF; font-size:22px; font-weight:800;">${action} on your account</h2>
                      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; max-width:540px; background:#1A1538; border:1px solid #3C3781; border-radius:14px; padding:14px 16px; color:#E9E7FF; font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:14px; box-shadow:0 10px 28px rgba(108,92,231,.18);">
                        <tr>
                          <td style="padding:8px 6px; color:#AFAAD8;">Time</td>
                          <td style="padding:8px 6px;" align="right"><strong>${whenISO}</strong></td>
                        </tr>
                        <tr>
                          <td style="padding:8px 6px; color:#AFAAD8;">IP</td>
                          <td style="padding:8px 6px;" align="right"><strong>${ip || 'Unknown'}</strong></td>
                        </tr>
                        <tr>
                          <td style="padding:8px 6px; color:#AFAAD8;">Location</td>
                          <td style="padding:8px 6px;" align="right"><strong>${location || 'Unknown'}</strong></td>
                        </tr>
                        <tr>
                          <td style="padding:8px 6px; color:#AFAAD8;">Device</td>
                          <td style="padding:8px 6px; font-family:Consolas, SFMono-Regular, Menlo, Monaco, monospace;" align="right"><strong>${(userAgent || 'Unknown').replace(/</g,'&lt;')}</strong></td>
                        </tr>
                      </table>
                      ${manageUrl ? `
                      <table align="center" role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto 0;">
                        <tr>
                          <td align="center" bgcolor="#6C5CE7" style="border-radius:12px;">
                            <a href="${manageUrl}" style="display:inline-block; padding:12px 18px; color:#FFFFFF; font-weight:700; font-family:Segoe UI,Roboto,Arial,sans-serif; text-decoration:none;">Review account activity</a>
                          </td>
                        </tr>
                      </table>` : ''}
                      <p style="margin:16px 0 0; color:#D7D4F3; font-size:14px;">If this was you, no action is needed. If you don’t recognize this activity, please reset your password immediately or contact <a href="mailto:${supportEmail}" style="color:#A89BFF; text-decoration:underline;">${supportEmail}</a>.</p>
                    </td>
                  </tr>
                </table>
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:18px 28px 26px; border-top:1px solid rgba(255,255,255,.06); font-family:Segoe UI,Roboto,Arial,sans-serif; color:#A8A5C9; font-size:12px;">
                      <div style="margin:0 0 4px;">&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</div>
                      <div style="color:#8F8BB5;">Security notification • Need help? <a href="mailto:${supportEmail}" style="color:#A89BFF; text-decoration:underline;">${supportEmail}</a></div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
  return { subject, text, html };
}

export function buildWelcomeEmail({ name = 'there', appName = 'Clyra AI', ctaUrl = '', supportEmail = 'contact@orincore.com' }) {
  const subject = `Welcome to ${appName}! Your account is verified`;
  const text = `Hi ${name},\n\nYour ${appName} account is now fully verified. You can create your own AI characters and start chatting with them right away.\n\nOpen ${appName} now to create your first character!\n\nNeed help? Contact ${supportEmail}.\n\n— The ${appName} Team`;
  const ctaHtml = ctaUrl ? `
    <table align="center" role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 8px;">
      <tr>
        <td align="center" bgcolor="#6C5CE7" style="border-radius:12px;">
          <a href="${ctaUrl}" style="display:inline-block; padding:12px 18px; color:#FFFFFF; font-weight:700; font-family:Segoe UI,Roboto,Arial,sans-serif; text-decoration:none;">Create your first AI Character</a>
        </td>
      </tr>
    </table>
  ` : '';
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <style>
      body,table,td,a{ -ms-text-size-adjust:100%; -webkit-text-size-adjust:100%; }
      table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }
      img{ -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
      table{ border-collapse:collapse !important; }
      body{ margin:0 !important; padding:0 !important; width:100% !important; height:100% !important; background-color:#0E0B1F; }
      a { color: #6C5CE7; text-decoration: none; }
      @media screen and (max-width:600px){ .container{ width:100% !important; } .px{ padding-left:20px !important; padding-right:20px !important; } }
    </style>
    <title>${appName} • Welcome</title>
  </head>
  <body style="background-color:#0E0B1F;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Welcome to ${appName}! Your account is verified.</div>
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table class="container" border="0" cellpadding="0" cellspacing="0" role="presentation" width="640" style="width:640px; max-width:640px;">
            <tr>
              <td style="background:#15122A; border-radius:16px; box-shadow:0 12px 32px rgba(24,16,80,.35);">
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:linear-gradient(135deg,#6C5CE7,#4B43BD); padding:28px 28px; border-top-left-radius:16px;border-top-right-radius:16px;">
                      <table width="100%" role="presentation">
                        <tr>
                          <td align="left" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:22px; font-weight:800; color:#FFFFFF; letter-spacing:.3px;">${appName}</td>
                          <td align="right" style="font-family:Segoe UI,Roboto,Arial,sans-serif; font-size:12px; color:#F3F2FF;">Welcome</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr><td style="height:1px; background:linear-gradient(90deg, rgba(108,92,231,.0), rgba(108,92,231,.45), rgba(108,92,231,.0));"></td></tr>
                </table>
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td class="px" style="padding:28px; font-family:Segoe UI,Roboto,Arial,sans-serif;">
                      <p style="margin:0 0 10px; color:#B8B5D8; font-size:16px;">Hi ${name},</p>
                      <h2 style="margin:0 0 12px; color:#FFFFFF; font-size:22px; font-weight:800;">Your account is verified!</h2>
                      <p style="margin:0 0 18px; color:#D7D4F3; font-size:15px; line-height:1.6;">You're all set. You can now create your own AI characters and start chatting with them. Get started by creating your first character.</p>
                      ${ctaHtml}
                      <p style="margin:14px 0 0; color:#9A97BB; font-size:12px; text-align:center;">Need help? Contact <a href="mailto:${supportEmail}" style="color:#A89BFF; text-decoration:underline;">${supportEmail}</a></p>
                    </td>
                  </tr>
                </table>
                <table width="100%" role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:18px 28px 26px; border-top:1px solid rgba(255,255,255,.06); font-family:Segoe UI,Roboto,Arial,sans-serif; color:#A8A5C9; font-size:12px;">
                      <div style="margin:0 0 4px;">&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</div>
                      <div style="margin:0 0 2px; color:#C9C6E6;">Welcome to the community</div>
                      <div style="color:#8F8BB5;">By Orincore Technologies — Adarsh Suradkar, CEO & Lead Developer</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
  return { subject, text, html };
}
