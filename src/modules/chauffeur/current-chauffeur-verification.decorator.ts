import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { CHAUFFEUR_VERIFICATION_ID } from "./chauffeur-session.guard";

export const CurrentChauffeurVerification = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [CHAUFFEUR_VERIFICATION_ID]?: string }>();
    return request[CHAUFFEUR_VERIFICATION_ID];
  },
);
