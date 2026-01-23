import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService } from "../database/database.service";
import { AuthEmailService } from "./auth-email.service";
import { type Auth, createAuth } from "./auth.config";

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private _auth: Auth | null = null;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<EnvConfig>,
    private readonly authEmailService: AuthEmailService,
  ) {}

  onModuleInit() {
    const sessionSecret = this.configService.get("SESSION_SECRET", { infer: true });
    const authBaseUrl = this.configService.get("AUTH_BASE_URL", { infer: true });
    const trustedOrigins = this.configService.get("TRUSTED_ORIGINS", { infer: true });
    const nodeEnv = this.configService.get("NODE_ENV", { infer: true });

    if (!sessionSecret || !authBaseUrl || !trustedOrigins?.length) {
      this.logger.warn(
        "Auth configuration incomplete. AuthService will not be initialized. " +
          "Set SESSION_SECRET, AUTH_BASE_URL, and TRUSTED_ORIGINS to enable auth.",
      );
      return;
    }

    this._auth = createAuth({
      prisma: this.databaseService,
      sessionSecret,
      authBaseUrl,
      trustedOrigins,
      secureCookies: nodeEnv !== "development",
      sendOTPEmail: this.authEmailService.sendOTPEmail.bind(this.authEmailService),
    });

    this.logger.log("Auth service initialized successfully");
  }

  get auth(): Auth {
    if (!this._auth) {
      throw new Error(
        "Auth service not initialized. Ensure SESSION_SECRET, AUTH_BASE_URL, and TRUSTED_ORIGINS are configured.",
      );
    }
    return this._auth;
  }

  get isInitialized(): boolean {
    return this._auth !== null;
  }
}
