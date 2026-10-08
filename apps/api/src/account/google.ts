import { OAuth2Client } from 'google-auth-library';
import { env } from '@copyra/core';

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity | null> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return null;
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) return null;
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    return null;
  }
  if (payload.email_verified !== true) return null;
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    name: payload.name ?? null,
  };
}
