import { env } from '@copyra/core';
import { Resend } from 'resend';

export async function sendAccountEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.ALERT_EMAIL_FROM?.trim() || env.ACCOUNT_EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    return { ok: false, error: 'Email delivery is not configured (RESEND_API_KEY / ACCOUNT_EMAIL_FROM).' };
  }
  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
