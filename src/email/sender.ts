import nodemailer from 'nodemailer';
import { config } from '../config';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      secure: config.email.smtpPort === 465,
      auth: {
        user: config.email.smtpUser,
        pass: config.email.smtpPass,
      },
    });
  }
  return transporter;
}

export async function sendEmail(opts: {
  subject: string;
  html: string;
  to?: string[];
}): Promise<void> {
  const recipients = opts.to ?? config.email.recipients;
  if (!recipients.length) {
    console.warn('No email recipients configured — skipping send');
    return;
  }

  await getTransporter().sendMail({
    from: config.email.from,
    to: recipients.join(', '),
    subject: opts.subject,
    html: opts.html,
  });

  console.log(`Email sent: "${opts.subject}" → ${recipients.join(', ')}`);
}
