import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { ADMIN, STAFF } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { AdminFinancialOperationsService } from "./admin-financial-operations.service";
import {
  type AdminPayoutListQueryDto,
  type AdminRefundListQueryDto,
  adminPayoutListQuerySchema,
  adminRefundListQuerySchema,
  financialOperationIdSchema,
  type ReconcileRefundBodyDto,
  reconcileRefundBodySchema,
} from "./dto/admin-financial-operations.dto";

@Controller("api/admin/financial-operations")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN, STAFF)
export class AdminFinancialOperationsController {
  constructor(private readonly adminFinancialOperationsService: AdminFinancialOperationsService) {}

  @Get("refunds")
  listRefunds(@ZodQuery(adminRefundListQuerySchema) query: AdminRefundListQueryDto) {
    return this.adminFinancialOperationsService.listRefunds(query);
  }

  @Get("refunds/:paymentId")
  getRefund(@ZodParam("paymentId", financialOperationIdSchema) paymentId: string) {
    return this.adminFinancialOperationsService.getRefund(paymentId);
  }

  @Post("refunds/:paymentId/reconcile")
  @HttpCode(HttpStatus.OK)
  @Roles(ADMIN)
  reconcileRefund(
    @ZodParam("paymentId", financialOperationIdSchema) paymentId: string,
    @ZodBody(reconcileRefundBodySchema) body: ReconcileRefundBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.adminFinancialOperationsService.reconcileRefund(paymentId, body, sessionUser.id);
  }

  @Get("payouts")
  listPayouts(@ZodQuery(adminPayoutListQuerySchema) query: AdminPayoutListQueryDto) {
    return this.adminFinancialOperationsService.listPayouts(query);
  }

  @Get("payouts/:payoutTransactionId")
  getPayout(
    @ZodParam("payoutTransactionId", financialOperationIdSchema)
    payoutTransactionId: string,
  ) {
    return this.adminFinancialOperationsService.getPayout(payoutTransactionId);
  }

  @Post("payouts/:payoutTransactionId/reconcile")
  @HttpCode(HttpStatus.OK)
  @Roles(ADMIN)
  reconcilePayout(
    @ZodParam("payoutTransactionId", financialOperationIdSchema)
    payoutTransactionId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.adminFinancialOperationsService.reconcilePayout(
      payoutTransactionId,
      sessionUser.id,
    );
  }
}
