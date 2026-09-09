import {
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Put,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ADMIN, FLEET_OWNER } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { idempotencyKeySchema } from "../booking/dto/idempotency-key.dto";
import { cuidParamSchema, type RejectBodyDto, rejectBodySchema } from "../car/dto/car-approval.dto";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import {
  type AccountDocuments,
  AccountDocumentsPipe,
  AccountDriverLicensePipe,
  MAX_ACCOUNT_DOCUMENT_SIZE_BYTES,
} from "./account-documents.pipe";
import {
  type AccountIdentityVerificationDto,
  accountIdentityVerificationSchema,
  type CheckPhoneVerificationDto,
  type CreateAccountVerificationDto,
  checkPhoneVerificationSchema,
  createAccountVerificationSchema,
  type DrivingCredentialsDto,
  drivingCredentialsSchema,
  type PayoutVerificationDto,
  payoutVerificationSchema,
  type SendPhoneVerificationDto,
  sendPhoneVerificationSchema,
  type UploadedAccountDocument,
} from "./account-verification.dto";
import { AccountVerificationService } from "./account-verification.service";
import { PhoneVerificationService } from "./phone-verification.service";
import { VerificationRequestInProgressException } from "./verification.error";
import { VerificationThrottlerGuard } from "./verification-throttler.guard";

const ACCOUNT_DOCUMENT_FIELDS = [
  { name: "driversLicense", maxCount: 1 },
  { name: "lasdri", maxCount: 1 },
] as const;
const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema);

@Controller("api/fleet-owner")
@UseGuards(SessionGuard, RoleGuard)
@Roles(FLEET_OWNER)
export class AccountVerificationController {
  constructor(
    private readonly accountVerificationService: AccountVerificationService,
    private readonly phoneVerificationService: PhoneVerificationService,
    private readonly flutterwaveService: FlutterwaveService,
  ) {}

  @Get("banks")
  @Header("Cache-Control", "private, max-age=3600")
  getBanks() {
    return this.flutterwaveService.listNigerianBanks();
  }

  @Get("onboarding")
  getStatus(@CurrentUser() user: AuthSession["user"]) {
    return this.accountVerificationService.getStatus(user.id);
  }

  @Put("documents/drivers-license")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_ACCOUNT_DOCUMENT_SIZE_BYTES },
    }),
  )
  replaceRejectedDriversLicense(
    @CurrentUser() user: AuthSession["user"],
    @UploadedFile(new AccountDriverLicensePipe()) file: UploadedAccountDocument,
  ) {
    return this.accountVerificationService.replaceRejectedDriversLicense(user.id, file);
  }

  @Post("phone-verifications")
  @UseGuards(VerificationThrottlerGuard)
  sendPhoneVerification(
    @CurrentUser() user: AuthSession["user"],
    @ZodBody(sendPhoneVerificationSchema) body: SendPhoneVerificationDto,
  ) {
    return this.phoneVerificationService.send(user.id, body);
  }

  @Post("phone-verification-checks")
  @UseGuards(VerificationThrottlerGuard)
  checkPhoneVerification(
    @CurrentUser() user: AuthSession["user"],
    @ZodBody(checkPhoneVerificationSchema) body: CheckPhoneVerificationDto,
  ) {
    return this.phoneVerificationService.check(user.id, body);
  }

  @Post("onboarding/identity-verifications")
  @UseGuards(VerificationThrottlerGuard)
  verifyIdentity(
    @CurrentUser() user: AuthSession["user"],
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @ZodBody(accountIdentityVerificationSchema) body: AccountIdentityVerificationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    return this.withRetryAfter(response, () =>
      this.accountVerificationService.verifyIdentityStage(user.id, idempotencyKey, body),
    );
  }

  @Post("onboarding/payout-verifications")
  @UseGuards(VerificationThrottlerGuard)
  verifyPayout(
    @CurrentUser() user: AuthSession["user"],
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @ZodBody(payoutVerificationSchema) body: PayoutVerificationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    return this.withRetryAfter(response, () =>
      this.accountVerificationService.verifyPayoutStage(user.id, idempotencyKey, body),
    );
  }

  @Put("onboarding/driving-credentials")
  @UseGuards(VerificationThrottlerGuard)
  @UseInterceptors(
    FileFieldsInterceptor([...ACCOUNT_DOCUMENT_FIELDS], {
      limits: { fileSize: MAX_ACCOUNT_DOCUMENT_SIZE_BYTES },
    }),
  )
  saveDrivingCredentials(
    @CurrentUser() user: AuthSession["user"],
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @ZodBody(drivingCredentialsSchema) body: DrivingCredentialsDto,
    @UploadedFiles(new AccountDocumentsPipe()) documents: AccountDocuments,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    return this.withRetryAfter(response, () =>
      this.accountVerificationService.saveDrivingCredentialsStage(
        user.id,
        idempotencyKey,
        body,
        documents,
      ),
    );
  }

  @Post("onboarding/submissions")
  @UseGuards(VerificationThrottlerGuard)
  submit(
    @CurrentUser() user: AuthSession["user"],
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    return this.withRetryAfter(response, () =>
      this.accountVerificationService.submitStage(user.id, idempotencyKey),
    );
  }

  @Post("account-verifications")
  @UseGuards(VerificationThrottlerGuard)
  @UseInterceptors(
    FileFieldsInterceptor([...ACCOUNT_DOCUMENT_FIELDS], {
      limits: { fileSize: MAX_ACCOUNT_DOCUMENT_SIZE_BYTES },
    }),
  )
  async createAccountVerification(
    @CurrentUser() user: AuthSession["user"],
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @ZodBody(createAccountVerificationSchema) body: CreateAccountVerificationDto,
    @UploadedFiles(new AccountDocumentsPipe()) documents: AccountDocuments,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    return this.withRetryAfter(response, () =>
      this.accountVerificationService.create(user.id, idempotencyKey, body, documents),
    );
  }

  private async withRetryAfter<T>(response: Response, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof VerificationRequestInProgressException) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  }
}

@Controller("api/admin/fleet-owner-account-verifications")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN)
export class AdminAccountVerificationController {
  constructor(private readonly accountVerificationService: AccountVerificationService) {}

  @Post(":verificationId/approve")
  approve(
    @ZodParam("verificationId", cuidParamSchema) verificationId: string,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.accountVerificationService.approve(verificationId, user.id);
  }

  @Post(":verificationId/reject")
  reject(
    @ZodParam("verificationId", cuidParamSchema) verificationId: string,
    @ZodBody(rejectBodySchema) body: RejectBodyDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.accountVerificationService.reject(verificationId, user.id, body.notes);
  }
}
