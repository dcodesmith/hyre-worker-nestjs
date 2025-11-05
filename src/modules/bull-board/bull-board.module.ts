import { BullAdapter } from "@bull-board/api/bullAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule as BaseBullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { NOTIFICATIONS_QUEUE, REMINDERS_QUEUE, STATUS_UPDATES_QUEUE } from "src/config/constants";

@Module({
  imports: [
    // Register Bull queues to inject them
    BullModule.registerQueue(
      { name: REMINDERS_QUEUE },
      { name: STATUS_UPDATES_QUEUE },
      { name: NOTIFICATIONS_QUEUE },
    ),
    // Configure Bull Board
    BaseBullBoardModule.forRoot({
      route: "/queues",
      adapter: ExpressAdapter,
    }),
    // Register queues with Bull Board
    BaseBullBoardModule.forFeature({
      name: REMINDERS_QUEUE,
      adapter: BullAdapter,
    }),
    BaseBullBoardModule.forFeature({
      name: STATUS_UPDATES_QUEUE,
      adapter: BullAdapter,
    }),
    BaseBullBoardModule.forFeature({
      name: NOTIFICATIONS_QUEUE,
      adapter: BullAdapter,
    }),
  ],
})
export class BullBoardModule {}
