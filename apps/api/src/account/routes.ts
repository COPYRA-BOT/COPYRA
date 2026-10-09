import { createHash } from 'node:crypto';
import { env, normalizeTelegramChatId, telegram } from '@copyra/core';
import { Chain, CustodyFamily, prisma } from '@copyra/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authModeFromRequest, readSession, verifyWalletSignature } from '../auth.js';
import { jsonSafe } from '../serialize.js';
import { audit } from './audit.js';
import { hashPassword, randomDigits, verifyPassword } from './crypto.js';
import { sendAccountEmail } from './email.js';
import {
  exchangeGoogleAuthCode,
  googleSecretConfigured,
  resolveGoogleClientId,
  verifyGoogleIdToken,
} from './google.js';
import {
  claimReferralToTrading,
  referralSummary,
  REFERRAL_STOP_REASON,
} from './referrals.js';
import {
  consumeEmailVerifyCode,
  consumePasswordResetCode,
  consumeStepUp,
  emailResendAllowed,
  rateLimitHit,
  rememberReferralCode,
  storeEmailVerifyCode,
  storePasswordResetCode,
  storeStepUp,
} from './redis-codes.js';
import { createAccountSession, readAccountSession, revokeAccountSession } from './session.js';
import {
  encryptTotpSecret,
  generateTotpSecret,
  hashRecoveryCode,
  makeRecoveryCodes,
  totpSetupPayload,
  verifyTotpCode,
} from './totp.js';
import {
  activateEmailUser,
  createEmailPendingUser,
  linkWalletToUser,
  publicAccount,
  publicUser,
  resolveReferrerId,
  upsertGoogleUser,
} from './users.js';
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.js';

function clientIp(request: FastifyRequest): string {
  return request.ip || '0.0.0.0';
}

/** CSRF: mutating account routes must come from an allowed web origin (or same-host). */
function assertCsrf(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return true;
  }
  const origin = String(request.headers.origin || '');
  const referer = String(request.headers.referer || '');
  const allowed = new Set(
    [env.PUBLIC_WEB_URL, env.PUBLIC_API_URL, env.PUBLIC_PLATFORM_URL, ...env.CORS_ORIGINS]
      .filter((u): u is string => Boolean(u))
      .map((u) => {
        try {
          return new URL(u).origin;
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );
  if (!origin && !referer) {
    // Non-browser clients (tests / curl) without Origin are rate-limited elsewhere.
    return true;
  }
  const candidate = origin || (() => {
    try {
      return new URL(referer).origin;
    } catch {
      return '';
    }
  })();
  if (candidate && allowed.has(candidate)) return true;
  reply.code(403).send({ error: 'CSRF check failed for this origin.' });
  return false;
}

async function requireAccount(request: FastifyRequest, reply: FastifyReply) {
  const session = await readAccountSession(request);
  if (!session) {
    reply.code(401).send({ error: 'Sign in required.' });
    return null;
  }
  return session;
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/account')) return;
    if (!assertCsrf(request, reply)) return;
  });

  /** Capture ?ref= into cookie (also called from frontend). */
  app.post('/api/account/ref', async (request, reply) => {
    const body = z.object({ code: z.string().min(4).max(64) }).parse(request.body ?? {});
    const code = body.code.trim().toLowerCase();
    const exists = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'Unknown referral code.' });
    rememberReferralCode(code, (name, value, maxAge) => {
      reply.setCookie(name, value, {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.PUBLIC_WEB_URL.startsWith('https://'),
        path: '/',
        maxAge,
      });
    });
    return { ok: true, code };
  });

  app.get('/api/account/me', async (request, reply) => {
    const session = await readAccountSession(request);
    if (!session) return reply.code(401).send({ error: 'Sign in required.' });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    const view = await publicAccount(user);
    return jsonSafe({
      user: view,
      connected: {
        sol: request.cookies.copyra_session_sol ? view.wallets.sol : null,
        evm: request.cookies.copyra_session_evm ? view.wallets.evm : null,
      },
    });
  });

  /**
   * Link / unlink this account's Telegram chat for BUY/SELL alerts only.
   * Ops / worker alerts stay on the platform TELEGRAM_CHAT_ID.
   * Uses the active mode session (SOL vs EVM) so dual accounts stay isolated.
   */
  async function requireModeAccount(request: FastifyRequest, reply: FastifyReply) {
    const mode = authModeFromRequest(request);
    // Prefer the mode session (SOL or EVM) so BUY/SELL alerts bind to that
    // mode's trading account. Account (email/Google) session is the fallback.
    const session = (await readSession(request, mode)) ?? (await readAccountSession(request));
    if (!session) {
      reply.code(401).send({
        error: `Sign in on ${mode.toUpperCase()} to link Telegram for BUY/SELL alerts.`,
      });
      return null;
    }
    return session;
  }

  app.get('/api/account/telegram', async (request, reply) => {
    const session = await requireModeAccount(request, reply);
    if (!session) return;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    const verify = await telegram.verify();
    const linked = Boolean(user.telegramChatId);
    return jsonSafe({
      linked,
      connected: linked,
      chatIdMasked: user.telegramChatId
        ? `${user.telegramChatId.slice(0, 3)}…${user.telegramChatId.slice(-3)}`
        : null,
      linkedAt: user.telegramLinkedAt,
      botUsername: verify.botUsername,
      botReady: verify.tokenValid,
    });
  });

  app.patch('/api/account/telegram', async (request, reply) => {
    const session = await requireModeAccount(request, reply);
    if (!session) return;
    const body = z
      .object({
        chatId: z.string().max(32).optional().nullable(),
        disconnect: z.boolean().optional(),
      })
      .parse(request.body ?? {});

    if (body.disconnect || body.chatId === null || body.chatId === '') {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { telegramChatId: null, telegramLinkedAt: null },
      });
      await audit('telegram_disconnect', { userId: session.user.id, request });
      return jsonSafe({ ok: true, linked: false, connected: false });
    }

    const chatId = normalizeTelegramChatId(String(body.chatId ?? ''));
    if (!chatId) {
      return reply.code(400).send({
        error: 'Enter a valid Telegram chat ID (digits only, e.g. 123456789). Open @userinfobot to find yours.',
      });
    }
    if (!telegram.enabled) {
      return reply.code(503).send({ error: 'Telegram bot is not configured on the server.' });
    }

    // Persist first so the next BUY/SELL confirmed alert resolves this chat.
    await prisma.user.update({
      where: { id: session.user.id },
      data: { telegramChatId: chatId, telegramLinkedAt: new Date() },
    });

    const probeOk = await telegram.sendNow(
      `✅ <b>COPYRA connected</b>\nThis chat will receive <b>BUY</b> and <b>SELL</b> alerts for your wallet only.\nOpen the bot and tap <b>Start</b> if this is your first message.`,
      { kind: 'telegram-link', userId: session.user.id },
    );
    await audit('telegram_link', { userId: session.user.id, request });

    return jsonSafe({
      ok: true,
      linked: true,
      connected: true,
      chatIdMasked: `${chatId.slice(0, 3)}…${chatId.slice(-3)}`,
      probeOk,
      hint: probeOk
        ? null
        : 'Connected. If you got no Telegram message, open the bot and tap Start, then Connect again.',
    });
  });

  app.post('/api/account/logout', async (request, reply) => {
    const session = await readAccountSession(request);
    await revokeAccountSession(request, reply);
    if (session) await audit('logout', { userId: session.user.id, request });
    return { ok: true };
  });

  // ---- Email + password -------------------------------------------------
  app.post('/api/account/register', async (request, reply) => {
    const body = z
      .object({
        email: z.string().email().max(320),
        password: z.string().min(8).max(200),
        ref: z.string().optional(),
      })
      .parse(request.body ?? {});
    const email = body.email.toLowerCase();
    const ip = clientIp(request);
    if (await rateLimitHit(`reg:ip:${ip}`, 10, 3600)) {
      return reply.code(429).send({ error: 'Too many registration attempts. Try again later.' });
    }
    if (await rateLimitHit(`reg:email:${email}`, 5, 3600)) {
      return reply.code(429).send({ error: 'Too many codes for this email. Try again later.' });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerifiedAt) {
      return reply.code(409).send({ error: 'An account with this email already exists. Sign in instead.' });
    }
    if (!(await emailResendAllowed(email)) && existing) {
      return reply.code(429).send({ error: 'Wait before requesting another code.' });
    }
    const passwordHash = await hashPassword(body.password);
    const referredById = await resolveReferrerId(request.cookies, body.ref);
    let user = existing;
    if (!user) {
      user = await createEmailPendingUser({ email, passwordHash, referredById });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, lastSeenAt: new Date() },
      });
    }
    if (referredById && referredById === user.id) {
      await prisma.user.update({ where: { id: user.id }, data: { referredById: null } });
    }
    const code = randomDigits(6);
    await storeEmailVerifyCode(email, code);
    const sent = await sendAccountEmail({
      to: email,
      subject: 'COPYRA verification code',
      text: `Your COPYRA verification code is ${code}. It expires in 10 minutes.`,
    });
    await audit('register_start', { userId: user.id, request, detail: { email } });
    if (!sent.ok) {
      // Dev / missing Resend: still return needVerify; never echo the code in production responses.
      const devHint = env.NODE_ENV === 'production' ? undefined : { devCode: code, emailError: sent.error };
      return jsonSafe({ needVerify: true, email, ...devHint });
    }
    return { needVerify: true, email };
  });

  app.post('/api/account/verify-email', async (request, reply) => {
    const body = z
      .object({ email: z.string().email(), code: z.string().min(4).max(12) })
      .parse(request.body ?? {});
    const email = body.email.toLowerCase();
    const result = await consumeEmailVerifyCode(email, body.code);
    if (result === 'locked') return reply.code(429).send({ error: 'Too many invalid codes. Request a new one.' });
    if (result !== 'ok') return reply.code(400).send({ error: 'Invalid or expired code.' });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(404).send({ error: 'Account not found.' });
    await activateEmailUser(user.id);
    await createAccountSession(user.id, reply, {
      userAgent: request.headers['user-agent'],
      ip: clientIp(request),
    });
    await audit('email_verified', { userId: user.id, request });
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return jsonSafe({ ok: true, user: publicUser(fresh), created: !user.emailVerifiedAt });
  });

  app.post('/api/account/login', async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1).max(200),
        code: z.string().optional(),
      })
      .parse(request.body ?? {});
    const email = body.email.toLowerCase();
    const ip = clientIp(request);
    if (await rateLimitHit(`login:ip:${ip}`, 30, 600)) {
      return reply.code(429).send({ error: 'Too many sign-in attempts.' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || !user.emailVerifiedAt) {
      return reply.code(401).send({ error: 'Invalid email or password.' });
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) return reply.code(401).send({ error: 'Invalid email or password.' });
    if (user.totpEnabled) {
      if (!body.code) return jsonSafe({ need2fa: true });
      if (!user.totpSecretEnc || !(await verifyTotpCode(user.id, user.totpSecretEnc, body.code))) {
        return reply.code(401).send({ error: 'Invalid 2FA code.' });
      }
    }
    await createAccountSession(user.id, reply, {
      userAgent: request.headers['user-agent'],
      ip: clientIp(request),
    });
    await audit('login_email', { userId: user.id, request });
    return jsonSafe({ ok: true, user: publicUser(user) });
  });

  app.post('/api/account/password-reset/request', async (request, reply) => {
    const body = z.object({ email: z.string().email() }).parse(request.body ?? {});
    const email = body.email.toLowerCase();
    if (await rateLimitHit(`pwreset:${email}`, 5, 3600)) {
      return reply.code(429).send({ error: 'Too many reset requests.' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    // Always OK to avoid account enumeration.
    if (user?.passwordHash) {
      const code = randomDigits(6);
      await storePasswordResetCode(email, code);
      await sendAccountEmail({
        to: email,
        subject: 'COPYRA password reset code',
        text: `Your COPYRA password reset code is ${code}. It expires in 10 minutes.`,
      });
      await audit('password_reset_request', { userId: user.id, request });
    }
    return { ok: true };
  });

  app.post('/api/account/password-reset/confirm', async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        code: z.string().min(4).max(12),
        password: z.string().min(8).max(200),
      })
      .parse(request.body ?? {});
    const email = body.email.toLowerCase();
    const result = await consumePasswordResetCode(email, body.code);
    if (result !== 'ok') return reply.code(400).send({ error: 'Invalid or expired reset code.' });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(404).send({ error: 'Account not found.' });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.password) },
    });
    await audit('password_reset_confirm', { userId: user.id, request });
    return { ok: true };
  });

  // ---- Google OIDC ------------------------------------------------------
  app.post('/api/account/google', async (request, reply) => {
    try {
      const parsed = z
        .object({
          idToken: z.string().min(20).optional(),
          credential: z.string().min(20).optional(),
          /** GIS oauth2 popup auth code (ux_mode: popup → redirect_uri postmessage). */
          code: z.string().min(10).optional(),
          ref: z.string().optional(),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Google sign-in requires a valid Google credential.' });
      }
      const clientId = resolveGoogleClientId();
      if (!clientId) {
        return reply.code(503).send({ error: 'Google sign-in is not configured (GOOGLE_CLIENT_ID).' });
      }

      let identity = null as Awaited<ReturnType<typeof verifyGoogleIdToken>>;
      if (parsed.data.code) {
        identity = await exchangeGoogleAuthCode(parsed.data.code);
        if (!identity) {
          return reply.code(401).send({
            error: googleSecretConfigured()
              ? 'Google authorization code was rejected. Try again.'
              : 'Set GOOGLE_CLIENT_SECRET on the API (App-Level) so Google sign-in can finish.',
          });
        }
      } else {
        const idToken = parsed.data.idToken || parsed.data.credential;
        if (!idToken) {
          return reply.code(400).send({
            error: 'Google sign-in requires a valid ID token or auth code. Click Sign in with Google again.',
          });
        }
        identity = await verifyGoogleIdToken(idToken);
        if (!identity) {
          return reply
            .code(401)
            .send({ error: 'Google token verification failed. Try again, or use another Google account.' });
        }
      }

      const referredById = await resolveReferrerId(request.cookies, parsed.data.ref);
      const { user, created } = await upsertGoogleUser({
        sub: identity.sub,
        email: identity.email,
        name: identity.name,
        referredById: referredById === undefined ? null : referredById,
      });
      if (user.referredById && user.referredById === user.id) {
        await prisma.user.update({ where: { id: user.id }, data: { referredById: null } });
      }
      await createAccountSession(user.id, reply, {
        userAgent: request.headers['user-agent'],
        ip: clientIp(request),
      });
      try {
        await audit(created ? 'google_create' : 'google_login', {
          userId: user.id,
          request,
          detail: { email: identity.email, googleSubPrefix: identity.sub.slice(0, 8) },
        });
      } catch {
        /* audit must never block sign-in */
      }
      const view = await publicAccount(user);
      return jsonSafe({ ok: true, created, user: view });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = /unique|already linked|already exists/i.test(message);
      return reply.code(conflict ? 409 : 500).send({
        error: conflict ? message : `Google sign-in failed: ${message.slice(0, 180)}`,
      });
    }
  });

  app.get('/api/account/google/config', async () => {
    const clientId = resolveGoogleClientId();
    return {
      clientId: clientId || null,
      enabled: Boolean(clientId),
      codeExchange: googleSecretConfigured(),
    };
  });

  // ---- Wallet link / account wallet login (uses existing SIWE/SIWS) ------
  app.post('/api/account/wallet/link', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z
      .object({
        kind: z.enum(['sol', 'evm']),
        address: z.string().min(20),
        signature: z.string().min(20),
        message: z.string().min(20),
        chainId: z.number().int().optional(),
      })
      .parse(request.body ?? {});
    const chain = body.kind === 'sol' ? Chain.SOLANA : Chain.BASE;
    const address =
      body.kind === 'sol' ? body.address : body.address.toLowerCase();
    const ok = await verifyWalletSignature({
      address: body.kind === 'sol' ? body.address : (body.address as `0x${string}`),
      storageAddress: address,
      chain,
      message: body.message,
      signature: body.signature,
    });
    if (!ok) return reply.code(401).send({ error: 'Wallet signature verification failed.' });
    try {
      await linkWalletToUser({
        userId: session.user.id,
        address,
        family: body.kind === 'sol' ? CustodyFamily.SOLANA : CustodyFamily.EVM,
      });
      // If account still has sentinel address, promote primary login address for this family.
      if (session.user.address.startsWith('acct_') && body.kind === 'sol') {
        await prisma.user.update({
          where: { id: session.user.id },
          data: { address, chain: Chain.SOLANA },
        });
      }
      await audit('wallet_link', { userId: session.user.id, request, detail: { kind: body.kind, address } });
      const fresh = await prisma.user.findUniqueOrThrow({
        where: { id: session.user.id },
        include: { walletLinks: true },
      });
      const view = publicUser(fresh);
      for (const link of fresh.walletLinks) {
        if (link.family === CustodyFamily.SOLANA) view.wallets.sol = link.address;
        if (link.family === CustodyFamily.EVM) view.wallets.evm = link.address;
      }
      return jsonSafe({ ok: true, user: view });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Link email+password to a wallet account (requires verified code). */
  app.post('/api/account/link/email', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8).max(200),
        code: z.string().min(4).max(12).optional(),
      })
      .parse(request.body ?? {});
    const email = body.email.toLowerCase();
    const taken = await prisma.user.findUnique({ where: { email } });
    if (taken && taken.id !== session.user.id) {
      return reply.code(409).send({ error: 'That email is already linked to another account.' });
    }
    if (!body.code) {
      if (!(await emailResendAllowed(email))) {
        return reply.code(429).send({ error: 'Wait before requesting another code.' });
      }
      const code = randomDigits(6);
      await storeEmailVerifyCode(email, code);
      await sendAccountEmail({
        to: email,
        subject: 'COPYRA email link code',
        text: `Your COPYRA code is ${code}. It expires in 10 minutes.`,
      });
      return { needVerify: true, email };
    }
    const result = await consumeEmailVerifyCode(email, body.code);
    if (result !== 'ok') return reply.code(400).send({ error: 'Invalid or expired code.' });
    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        email,
        emailVerifiedAt: new Date(),
        passwordHash: await hashPassword(body.password),
      },
      include: { walletLinks: true },
    });
    await audit('email_link', { userId: user.id, request, detail: { email } });
    const view = publicUser(user);
    for (const link of user.walletLinks) {
      if (link.family === CustodyFamily.SOLANA) view.wallets.sol = link.address;
      if (link.family === CustodyFamily.EVM) view.wallets.evm = link.address;
    }
    return jsonSafe({ ok: true, user: view });
  });

  // ---- Step-up (withdrawals / sensitive) --------------------------------
  app.post('/api/account/step-up', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z
      .object({
        code: z.string().min(4).max(12).optional(),
        password: z.string().min(1).max(200).optional(),
        kind: z.enum(['totp', 'wallet', 'password']).optional(),
        address: z.string().optional(),
        signature: z.string().optional(),
        message: z.string().optional(),
        chainId: z.number().int().optional(),
      })
      .parse(request.body ?? {});
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    if (user.totpEnabled && user.totpSecretEnc) {
      if (!body.code) return reply.code(400).send({ error: 'Authenticator code required.', need2fa: true });
      if (!(await verifyTotpCode(user.id, user.totpSecretEnc, body.code))) {
        return reply.code(401).send({ error: 'Invalid 2FA code.' });
      }
      const token = await storeStepUp(user.id, 'totp');
      return { ok: true, stepUpToken: token, kind: 'totp' };
    }
    if (user.passwordHash && body.password) {
      if (!(await verifyPassword(user.passwordHash, body.password))) {
        return reply.code(401).send({ error: 'Incorrect password.' });
      }
      const token = await storeStepUp(user.id, 'totp');
      return { ok: true, stepUpToken: token, kind: 'password' };
    }
    if (body.address && body.signature && body.message) {
      const isSol = !body.address.startsWith('0x');
      const chain = isSol ? Chain.SOLANA : Chain.BASE;
      const address = isSol ? body.address : body.address.toLowerCase();
      const ok = await verifyWalletSignature({
        address: isSol ? body.address : (body.address as `0x${string}`),
        storageAddress: address,
        chain,
        message: body.message,
        signature: body.signature,
      });
      if (!ok) return reply.code(401).send({ error: 'Wallet signature verification failed.' });
      const link = await prisma.userWalletLink.findFirst({
        where: { userId: user.id, address },
      });
      if (!link && user.address !== address) {
        return reply.code(403).send({ error: 'Sign with a wallet linked to this account.' });
      }
      const token = await storeStepUp(user.id, 'wallet');
      return { ok: true, stepUpToken: token, kind: 'wallet' };
    }
    return reply.code(400).send({
      error: user.email
        ? 'Enable 2FA or provide an authenticator code for step-up.'
        : 'Provide a fresh wallet signature for step-up.',
      needWallet: !user.totpEnabled,
    });
  });

  app.post('/api/account/step-up/check', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z.object({ token: z.string().min(10) }).parse(request.body ?? {});
    const ok = await consumeStepUp(session.user.id, body.token);
    return { ok };
  });

  // ---- 2FA --------------------------------------------------------------
  app.post('/api/account/2fa/setup', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    if (!user.email) {
      return reply.code(400).send({ error: 'Add and verify an email before enabling authenticator 2FA.' });
    }
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: encryptTotpSecret(secret), totpEnabled: false },
    });
    const payload = await totpSetupPayload(user.email, secret);
    await audit('2fa_setup', { userId: user.id, request });
    return { secret: payload.secret, uri: payload.otpauth, qr: payload.qrDataUrl };
  });

  app.post('/api/account/2fa/enable', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z.object({ code: z.string().min(4).max(12) }).parse(request.body ?? {});
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    if (!user.totpSecretEnc) return reply.code(400).send({ error: 'Run 2FA setup first.' });
    if (!(await verifyTotpCode(user.id, user.totpSecretEnc, body.code))) {
      return reply.code(400).send({ error: 'Invalid authenticator code.' });
    }
    const recovery = makeRecoveryCodes(10);
    await prisma.recoveryCode.deleteMany({ where: { userId: user.id } });
    await prisma.recoveryCode.createMany({
      data: recovery.hashes.map((codeHash) => ({ userId: user.id, codeHash })),
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true, totpEnabledAt: new Date() },
    });
    await audit('2fa_enable', { userId: user.id, request });
    return { ok: true, recoveryCodes: recovery.plain };
  });

  app.post('/api/account/2fa/disable', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z.object({ code: z.string().min(4).max(12) }).parse(request.body ?? {});
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    if (!user.totpEnabled || !user.totpSecretEnc) {
      return reply.code(400).send({ error: '2FA is not enabled.' });
    }
    const asTotp = await verifyTotpCode(user.id, user.totpSecretEnc, body.code);
    const recovery = await prisma.recoveryCode.findFirst({
      where: { userId: user.id, usedAt: null, codeHash: hashRecoveryCode(body.code) },
    });
    if (!asTotp && !recovery) return reply.code(400).send({ error: 'Invalid code.' });
    if (recovery) {
      await prisma.recoveryCode.update({ where: { id: recovery.id }, data: { usedAt: new Date() } });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: false, totpSecretEnc: null, totpEnabledAt: null },
    });
    await prisma.recoveryCode.deleteMany({ where: { userId: user.id } });
    await audit('2fa_disable', { userId: user.id, request });
    return { ok: true };
  });

  // ---- Devices ----------------------------------------------------------
  app.get('/api/account/devices', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const rows = await prisma.session.findMany({
      where: { userId: session.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const currentTokenHash = currentSessionTokenHash(request);
    const passkeys = await prisma.webAuthnCredential.findMany({
      where: { userId: session.user.id },
      select: { id: true, name: true, createdAt: true },
    });
    return jsonSafe({
      devices: rows.map((d) => ({
        id: d.id,
        name: d.userAgent?.slice(0, 80) || 'Device',
        first: d.createdAt.getTime(),
        last: d.createdAt.getTime(),
        current: Boolean(currentTokenHash && d.tokenHash === currentTokenHash),
      })),
      passkeys: passkeys.map((p) => ({
        id: p.id,
        name: p.name || 'Passkey',
        at: p.createdAt.getTime(),
        sim: false,
      })),
    });
  });

  app.post('/api/account/devices/revoke', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z.object({ id: z.string().min(1) }).parse(request.body ?? {});
    await prisma.session.updateMany({
      where: { id: body.id, userId: session.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit('device_revoke', { userId: session.user.id, request, detail: { id: body.id } });
    return { ok: true };
  });

  // ---- Referrals --------------------------------------------------------
  app.get('/api/account/referral', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    return jsonSafe(await referralSummary(session.user.id));
  });

  app.post('/api/account/referral/claim', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z.object({ mode: z.enum(['sol', 'evm']).default('evm') }).parse(request.body ?? {});
    const result = await claimReferralToTrading(session.user.id, body.mode);
    await audit('referral_claim', {
      userId: session.user.id,
      request,
      detail: { ...result },
    });
    // Always 200 with claimed:false so the UI can show the STOP reason without a hard error.
    if (!result.claimed) {
      return jsonSafe({
        claimed: false,
        amount: 0,
        reason: result.reason,
        error:
          result.reason === REFERRAL_STOP_REASON
            ? 'Referral earnings are disabled until platform fees are collected on confirmed trades.'
            : result.reason === 'BELOW_MINIMUM'
              ? 'Claimable amount is below the minimum.'
              : 'Nothing to claim.',
      });
    }
    return jsonSafe(result);
  });

  // ---- WebAuthn / passkeys ----------------------------------------------
  app.post('/api/account/passkeys/options', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    const options = await registrationOptions(user.id, user.email);
    return options;
  });

  app.post('/api/account/passkeys/register', async (request, reply) => {
    const session = await requireAccount(request, reply);
    if (!session) return;
    const body = z
      .object({
        credential: z.unknown(),
        name: z.string().max(80).optional(),
      })
      .parse(request.body ?? {});
    const result = await verifyRegistration(session.user.id, body.credential, body.name);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    await audit('passkey_register', { userId: session.user.id, request, detail: { id: result.id } });
    return { ok: true, id: result.id };
  });

  app.post('/api/account/passkeys/login/options', async (request, reply) => {
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(request.body ?? {});
    try {
      const { options } = await authenticationOptions(body.ids);
      return options;
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/account/passkeys/login', async (request, reply) => {
    const body = z.object({ credential: z.unknown() }).parse(request.body ?? {});
    const result = await verifyAuthentication(body.credential);
    if (!result.ok) return reply.code(401).send({ error: result.error });
    await createAccountSession(result.userId, reply, {
      userAgent: request.headers['user-agent'],
      ip: clientIp(request),
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      include: { walletLinks: true },
    });
    await audit('passkey_login', { userId: user.id, request });
    const view = publicUser(user);
    for (const link of user.walletLinks) {
      if (link.family === CustodyFamily.SOLANA) view.wallets.sol = link.address;
      if (link.family === CustodyFamily.EVM) view.wallets.evm = link.address;
    }
    return jsonSafe({ ok: true, user: view });
  });

  // ---- Guest public stats -----------------------------------------------
  app.get('/api/account/public/stats', async () => {
    const [traders, openPositions, confirmedTrades] = await Promise.all([
      prisma.trader.count({ where: { enabled: true } }),
      prisma.position.count({ where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } } }),
      prisma.trade.count({ where: { status: 'CONFIRMED' } }),
    ]);
    return {
      traders,
      openPositions,
      confirmedTrades,
      guest: true,
      note: 'Public stats only. Sign in for custody, deposits, and copy trading.',
    };
  });

}

function currentSessionTokenHash(request: FastifyRequest): string | null {
  const token =
    request.cookies.copyra_session_acct ||
    request.cookies.copyra_session_sol ||
    request.cookies.copyra_session_evm;
  if (!token) return null;
  return createHash('sha256').update(token).digest('hex');
}
