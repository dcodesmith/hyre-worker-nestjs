import type { PrismaClient } from "@prisma/client";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { bearer, emailOTP } from "better-auth/plugins";

export interface AuthConfigOptions {
  prisma: PrismaClient;
  sessionSecret: string;
  authBaseUrl: string;
  trustedOrigins: string[];
  sendOTPEmail: (email: string, otp: string) => Promise<void>;
  secureCookies: boolean;
}

export function createAuth(options: AuthConfigOptions) {
  const { prisma, sessionSecret, authBaseUrl, trustedOrigins, sendOTPEmail, secureCookies } =
    options;

  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    secret: sessionSecret,
    baseURL: authBaseUrl,
    trustedOrigins,
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 minutes
      },
    },
    plugins: [
      emailOTP({
        expiresIn: 600, // 10 minutes
        otpLength: 6,
        async sendVerificationOTP({ email, otp }) {
          await sendOTPEmail(email, otp);
        },
      }),
      bearer(),
    ],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "database",
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/email-otp/check-verification-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: "", // Web app handles __Host- prefix
      defaultCookieAttributes: {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
