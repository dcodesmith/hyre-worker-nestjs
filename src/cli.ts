import "reflect-metadata";
import { CommandFactory } from "nest-commander";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  await CommandFactory.run(AppModule, ["log", "warn", "error"]);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`[cli] ${message}`);
  process.exit(1);
});
