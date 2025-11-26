import { sendEmail } from '../src/services/email.service.js';
import env from '../src/config/env.js';

async function main() {
  try {
    const to = process.argv[2] || env.SMTP_USER;
    if (!to) {
      console.error('Usage: node scripts/send-test-email-simple.js <recipient-email>');
      console.error('Or set SMTP_USER in your .env to a valid email.');
      process.exit(1);
    }

    console.log('[test-email] Using SMTP config:', {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      from: env.SMTP_FROM || env.SMTP_USER,
    });

    const subject = 'Clyra AI test email';
    const text = 'This is a plain-text test email from Clyra AI backend.';
    const html = '<p>This is a <strong>test email</strong> from Clyra AI backend.</p>';

    const info = await sendEmail({ to, subject, text, html });
    console.log('[test-email] Email sent:', {
      messageId: info?.messageId,
      response: info?.response,
      accepted: info?.accepted,
      rejected: info?.rejected,
    });

    process.exit(0);
  } catch (err) {
    console.error('[test-email] Failed to send email:', err?.message || err);
    process.exit(1);
  }
}

main();
