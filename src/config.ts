import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  chatwoot: {
    apiToken: optional('CHATWOOT_API_TOKEN', ''),
    accountId: optional('CHATWOOT_ACCOUNT_ID', ''),
    baseUrl: optional('CHATWOOT_BASE_URL', 'https://app.chatwoot.com'),
  },

  openphone: {
    webhookSecret: optional('OPENPHONE_WEBHOOK_SECRET', ''),
    driverNumberId: optional('DRIVER_OPENPHONE_NUMBER_ID', ''),
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY', ''),
  },

  openai: {
    apiKey: optional('OPENAI_API_KEY', ''),
  },

  database: {
    url: optional('DATABASE_URL', 'postgresql://localhost:5432/omnicommerce_support'),
  },

  email: {
    smtpHost: optional('SMTP_HOST', 'smtp.sendgrid.net'),
    smtpPort: parseInt(optional('SMTP_PORT', '587'), 10),
    smtpUser: optional('SMTP_USER', 'apikey'),
    smtpPass: optional('SMTP_PASS', ''),
    from: optional('EMAIL_FROM', 'support-alerts@omnicommerce.com'),
    recipients: optional('EMAIL_RECIPIENTS', '').split(',').filter(Boolean),
    timezone: optional('EMAIL_TIMEZONE', 'America/Phoenix'),
  },

  clustering: {
    threshold: parseFloat(optional('CLUSTERING_THRESHOLD', '0.82')),
  },

  dashboardUrl: optional('DASHBOARD_URL', 'http://localhost:3000'),
} as const;
