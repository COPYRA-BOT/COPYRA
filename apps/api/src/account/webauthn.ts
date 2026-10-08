import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { env } from '@copyra/core';
import { prisma } from '@copyra/db';
import { storeWebAuthnChallenge, takeWebAuthnChallenge } from './redis-codes.js';

function rpID(): string {
  return (env.WEBAUTHN_RP_ID?.trim() || new URL(env.PUBLIC_WEB_URL).hostname).replace(/^\./, '');
}

function rpName(): string {
  return env.WEBAUTHN_RP_NAME?.trim() || 'COPYRA';
}

function origin(): string {
  return env.PUBLIC_WEB_URL.replace(/\/+$/, '');
}

function transportsOf(raw: string | null | undefined): AuthenticatorTransport[] | undefined {
  const list = raw?.split(',').filter(Boolean) as AuthenticatorTransport[] | undefined;
  return list?.length ? list : undefined;
}

export async function registrationOptions(userId: string, email: string | null) {
  const existing = await prisma.webAuthnCredential.findMany({ where: { userId } });
  const options = await generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpID(),
    userName: email || userId,
    userID: new TextEncoder().encode(userId),
    userDisplayName: email || 'COPYRA user',
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: transportsOf(c.transports),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  await storeWebAuthnChallenge(userId, options.challenge);
  return options;
}

export async function verifyRegistration(
  userId: string,
  response: unknown,
  name?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const expectedChallenge = await takeWebAuthnChallenge(userId);
  if (!expectedChallenge) return { ok: false, error: 'Passkey challenge expired. Try again.' };
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge,
      expectedOrigin: origin(),
      expectedRPID: rpID(),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Passkey verification failed.' };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'Passkey verification failed.' };
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await prisma.webAuthnCredential.create({
    data: {
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: BigInt(credential.counter),
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports?.join(',') ?? null,
      name: name?.slice(0, 80) || 'Passkey',
    },
  });
  return { ok: true, id: credential.id };
}

export async function authenticationOptions(allowCredentialIds?: string[]) {
  if (!allowCredentialIds?.length) {
    throw new Error('No passkey saved on this device yet. Sign in once, then add a passkey in Devices & passkeys.');
  }
  const creds = await prisma.webAuthnCredential.findMany({
    where: { id: { in: allowCredentialIds } },
    take: 50,
  });
  if (!creds.length) {
    throw new Error('No passkeys registered for this account.');
  }
  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: transportsOf(c.transports),
    })),
    userVerification: 'preferred',
  });
  // Store under a synthetic key using challenge hash for login (no user yet).
  await storeWebAuthnChallenge(`login:${options.challenge}`, options.challenge);
  return { options, userIds: creds.map((c) => c.userId) };
}

export async function verifyAuthentication(
  response: unknown,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const body = response as { id?: string; rawId?: string; response?: { clientDataJSON?: string } };
  const credId = body.id || body.rawId;
  if (!credId) return { ok: false, error: 'Missing passkey id.' };
  const cred = await prisma.webAuthnCredential.findUnique({ where: { id: credId } });
  if (!cred) return { ok: false, error: 'Unknown passkey.' };

  let expectedChallenge: string | null = null;
  try {
    const clientData = JSON.parse(
      Buffer.from(body.response?.clientDataJSON || '', 'base64url').toString('utf8'),
    ) as { challenge?: string };
    if (clientData.challenge) {
      expectedChallenge = await takeWebAuthnChallenge(`login:${clientData.challenge}`);
    }
  } catch {
    expectedChallenge = null;
  }
  if (!expectedChallenge) {
    // Also try user-scoped challenge from registration-adjacent flows.
    expectedChallenge = await takeWebAuthnChallenge(cred.userId);
  }
  if (!expectedChallenge) return { ok: false, error: 'Passkey challenge expired. Try again.' };

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge,
      expectedOrigin: origin(),
      expectedRPID: rpID(),
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey, 'base64url'),
        counter: Number(cred.counter),
        transports: transportsOf(cred.transports),
      },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Passkey login failed.' };
  }
  if (!verification.verified) return { ok: false, error: 'Passkey login failed.' };
  await prisma.webAuthnCredential.update({
    where: { id: cred.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter) },
  });
  return { ok: true, userId: cred.userId };
}
