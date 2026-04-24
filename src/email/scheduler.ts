import cron from 'node-cron';
import { config } from '../config';
import { sendDailySummary } from './daily';
import { sendWeeklySummary } from './weekly';

export function startEmailScheduler(): void {
  // Daily summary: 7:00 AM in configured timezone
  cron.schedule(
    '0 7 * * *',
    async () => {
      try {
        await sendDailySummary();
      } catch (err) {
        console.error('Daily email job failed:', err);
      }
    },
    { timezone: config.email.timezone }
  );

  // Weekly trend: 8:00 AM every Monday in configured timezone
  cron.schedule(
    '0 8 * * 1',
    async () => {
      try {
        await sendWeeklySummary();
      } catch (err) {
        console.error('Weekly email job failed:', err);
      }
    },
    { timezone: config.email.timezone }
  );

  console.log(`Email scheduler started (timezone: ${config.email.timezone})`);
  console.log('  Daily digest:  07:00 daily');
  console.log('  Weekly trends: 08:00 Mondays');
}
