import {
  Controller,
  Get,
  Headers,
  Patch,
  Post,
  Put,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { ZodBody, ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { FLEET_OWNER } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
import { idempotencyKeySchema } from "../booking/dto/idempotency-key.dto";
import { VerificationThrottlerGuard } from "../verification/verification-throttler.guard";
import {
  type AcceptChauffeurConsentDto,
  acceptChauffeurConsentSchema,
  type CheckChauffeurPhoneDto,
  type CreateChauffeurInvitationDto,
  chauffeurIdParamSchema,
  checkChauffeurPhoneSchema,
  createChauffeurInvitationSchema,
  type ExchangeChauffeurInvitationDto,
  exchangeChauffeurInvitationSchema,
  type ListChauffeursQueryDto,
  listChauffeursQuerySchema,
  type UpdateChauffeurDto,
  type UploadedChauffeurSelfie,
  updateChauffeurSchema,
  type VerifyChauffeurDrivingDto,
  type VerifyChauffeurNinDto,
  verifyChauffeurDrivingSchema,
  verifyChauffeurNinSchema,
} from "./chauffeur.dto";
import { ChauffeurRequestInProgressException } from "./chauffeur.error";
import { ChauffeurService } from "./chauffeur.service";
import { ChauffeurSelfiePipe, MAX_CHAUFFEUR_SELFIE_SIZE_BYTES } from "./chauffeur-selfie.pipe";
import { ChauffeurSessionGuard } from "./chauffeur-session.guard";
import { CurrentChauffeurVerification } from "./current-chauffeur-verification.decorator";

const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema);

@Controller("api/fleet-owner")
@UseGuards(SessionGuard, RoleGuard, VerifiedFleetOwnerGuard)
@Roles(FLEET_OWNER)
export class FleetOwnerChauffeurController {
  constructor(private readonly chauffeurService: ChauffeurService) {}

  @Post("chauffeur-invitations")
  @UseGuards(VerificationThrottlerGuard)
  createInvitation(
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @ZodBody(createChauffeurInvitationSchema) body: CreateChauffeurInvitationDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.chauffeurService.createInvitation(
      user.id,
      idempotencyKeyPipe.transform(rawIdempotencyKey),
      body,
    );
  }

  @Get("chauffeurs")
  list(
    @CurrentUser() user: AuthSession["user"],
    @ZodQuery(listChauffeursQuerySchema) query: ListChauffeursQueryDto,
  ) {
    return this.chauffeurService.list(user.id, query);
  }

  @Patch("chauffeurs/:chauffeurId")
  update(
    @CurrentUser() user: AuthSession["user"],
    @ZodParam("chauffeurId", chauffeurIdParamSchema) chauffeurId: string,
    @ZodBody(updateChauffeurSchema) body: UpdateChauffeurDto,
  ) {
    return this.chauffeurService.update(user.id, chauffeurId, body);
  }
}

@Controller("api/chauffeur-onboarding")
export class ChauffeurOnboardingController {
  constructor(private readonly chauffeurService: ChauffeurService) {}

  @Post("invitation-exchanges")
  @UseGuards(VerificationThrottlerGuard)
  exchangeInvitation(
    @ZodBody(exchangeChauffeurInvitationSchema) body: ExchangeChauffeurInvitationDto,
  ) {
    return this.chauffeurService.exchangeInvitation(body.token);
  }

  @Get()
  @UseGuards(ChauffeurSessionGuard)
  get(@CurrentChauffeurVerification() verificationId: string) {
    return this.chauffeurService.getOnboarding(verificationId);
  }

  @Put("consent")
  @UseGuards(ChauffeurSessionGuard)
  acceptConsent(
    @CurrentChauffeurVerification() verificationId: string,
    @ZodBody(acceptChauffeurConsentSchema) _body: AcceptChauffeurConsentDto,
  ) {
    return this.chauffeurService.acceptConsent(verificationId);
  }

  @Post("phone-verifications")
  @UseGuards(ChauffeurSessionGuard, VerificationThrottlerGuard)
  sendPhoneVerification(@CurrentChauffeurVerification() verificationId: string) {
    return this.chauffeurService.sendPhoneVerification(verificationId);
  }

  @Post("phone-verification-checks")
  @UseGuards(ChauffeurSessionGuard, VerificationThrottlerGuard)
  checkPhoneVerification(
    @CurrentChauffeurVerification() verificationId: string,
    @ZodBody(checkChauffeurPhoneSchema) body: CheckChauffeurPhoneDto,
  ) {
    return this.chauffeurService.checkPhoneVerification(verificationId, body.code);
  }

  @Post("nin-verifications")
  @UseGuards(ChauffeurSessionGuard, VerificationThrottlerGuard)
  verifyNin(
    @CurrentChauffeurVerification() verificationId: string,
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @ZodBody(verifyChauffeurNinSchema) body: VerifyChauffeurNinDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.withRetryAfter(response, () =>
      this.chauffeurService.verifyNin(
        verificationId,
        idempotencyKeyPipe.transform(rawIdempotencyKey),
        body,
      ),
    );
  }

  @Post("driving-verifications")
  @UseGuards(ChauffeurSessionGuard, VerificationThrottlerGuard)
  @UseInterceptors(
    FileInterceptor("selfie", {
      limits: { fileSize: MAX_CHAUFFEUR_SELFIE_SIZE_BYTES },
    }),
  )
  verifyDriving(
    @CurrentChauffeurVerification() verificationId: string,
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @ZodBody(verifyChauffeurDrivingSchema) body: VerifyChauffeurDrivingDto,
    @UploadedFile(new ChauffeurSelfiePipe()) selfie: UploadedChauffeurSelfie,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.withRetryAfter(response, () =>
      this.chauffeurService.verifyDriving(
        verificationId,
        idempotencyKeyPipe.transform(rawIdempotencyKey),
        body,
        selfie,
      ),
    );
  }

  private async withRetryAfter<T>(response: Response, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ChauffeurRequestInProgressException) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  }
}
