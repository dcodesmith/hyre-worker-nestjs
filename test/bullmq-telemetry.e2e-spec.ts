import {
  BullModule,
  getQueueToken,
  getSharedConfigToken,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from "@nestjs/bullmq";
import { type INestApplication, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { metrics, NodeSDK, tracing } from "@opentelemetry/sdk-node";
import type { Job, Queue, QueueOptions } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureTerminalJobFailure } from "../src/modules/infra/queue-infra/bullmq-telemetry";
import { QueueInfraModule } from "../src/modules/infra/queue-infra/queue-infra.module";
import { captureException } from "../src/sentry";

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("../src/sentry", () => ({
  captureException: captureExceptionMock,
  flushSentry: vi.fn().mockResolvedValue(true),
}));

const QUEUE_NAME = `bullmq-otel-e2e-${process.env.VITEST_WORKER_ID ?? "0"}`;
const SECRET = "user-email-secret@example.com";

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let firstFailed = createDeferred();
let secondFailed = createDeferred();
let failedEvents = 0;

@Processor(QUEUE_NAME, { concurrency: 1 })
class TelemetryProbeProcessor extends WorkerHost {
  async process(job: Job<{ fail?: boolean }>): Promise<{ ok: true }> {
    await job.updateProgress({ email: SECRET });

    if (job.data.fail) {
      throw new Error(`processor failed for ${SECRET}`);
    }

    return { ok: true };
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<{ fail?: boolean }> | undefined, error: Error): void {
    captureTerminalJobFailure(job, error, QUEUE_NAME);
    failedEvents += 1;
    if (failedEvents === 1) {
      firstFailed.resolve();
    }
    if (failedEvents === 2) {
      secondFailed.resolve();
    }
  }
}

@Module({
  imports: [QueueInfraModule, BullModule.registerQueue({ name: QUEUE_NAME })],
  providers: [TelemetryProbeProcessor],
})
class BullMqTelemetryProbeModule {}

function exportedTelemetryDump(spans: tracing.ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events.map((event) => ({
        name: event.name,
        attributes: event.attributes,
      })),
    })),
  );
}

function metricNames(exporter: metrics.InMemoryMetricExporter): string[] {
  return exporter
    .getMetrics()
    .flatMap((resourceMetrics) =>
      resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics.map((metric) => metric.descriptor.name),
      ),
    );
}

describe("BullMQ OpenTelemetry (e2e)", () => {
  let app: INestApplication;
  let otelSdk: NodeSDK;
  let spanExporter: tracing.InMemorySpanExporter;
  let metricExporter: metrics.InMemoryMetricExporter;
  let metricReader: metrics.PeriodicExportingMetricReader;
  let queue: Queue;

  beforeAll(async () => {
    spanExporter = new tracing.InMemorySpanExporter();
    metricExporter = new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE);
    metricReader = new metrics.PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000,
    });

    otelSdk = new NodeSDK({
      autoDetectResources: false,
      instrumentations: [],
      spanProcessors: [new tracing.SimpleSpanProcessor(spanExporter)],
      metricReaders: [metricReader],
    });
    otelSdk.start();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
        }),
        BullMqTelemetryProbeModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication({ logger: false });
    await app.init();

    queue = app.get<Queue>(getQueueToken(QUEUE_NAME));
    await queue.drain(true);
  });

  beforeEach(() => {
    captureExceptionMock.mockClear();
    failedEvents = 0;
    firstFailed = createDeferred();
    secondFailed = createDeferred();
  });

  afterAll(async () => {
    await queue?.drain(true);
    await app?.close();
    await otelSdk?.shutdown();
  });

  it("shares one telemetry config and propagates producer-to-consumer traces and metrics", async () => {
    const sharedConfig = app.get<QueueOptions>(getSharedConfigToken());

    expect(queue.opts.telemetry).toBe(sharedConfig.telemetry);
    expect(sharedConfig.telemetry?.meter).toBeDefined();

    spanExporter.reset();
    metricExporter.reset();

    const job = await queue.add("probe", { fail: false }, { attempts: 1 });
    await vi.waitFor(async () => {
      expect(await job.getState()).toBe("completed");
    });

    await vi.waitFor(() => {
      const finished = spanExporter.getFinishedSpans();
      expect(finished.find((span) => span.name.startsWith("add "))).toBeDefined();
      expect(finished.find((span) => span.name.startsWith("process "))).toBeDefined();
    });

    const spans = spanExporter.getFinishedSpans();
    const producer = spans.find((span) => span.name.startsWith("add "));
    const consumer = spans.find((span) => span.name.startsWith("process "));

    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();
    expect(producer?.spanContext().traceId).toBe(consumer?.spanContext().traceId);
    expect(job.opts.telemetry?.metadata).toEqual(expect.any(String));
    expect(job.opts.telemetry?.metadata).not.toBe("{}");

    const dump = exportedTelemetryDump(spans);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("bullmq.job.result");
    expect(dump).not.toContain("bullmq.job.progress");

    await metricReader.forceFlush();
    expect(metricNames(metricExporter)).toContain("bullmq.jobs.completed");
  });

  it("does not export failed job reasons or original exception details", async () => {
    spanExporter.reset();

    const job = await queue.add("probe", { fail: true }, { attempts: 1 });
    await vi.waitFor(async () => {
      expect(await job.getState()).toBe("failed");
    });

    await vi.waitFor(() => {
      expect(
        spanExporter
          .getFinishedSpans()
          .flatMap((span) => span.events)
          .find((event) => event.name === "job failed"),
      ).toBeDefined();
    });

    const spans = spanExporter.getFinishedSpans();
    const failedEvent = spans
      .flatMap((span) => span.events)
      .find((event) => event.name === "job failed");

    expect(failedEvent).toBeDefined();
    expect(failedEvent?.attributes ?? {}).toEqual({});

    const dump = exportedTelemetryDump(spans);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("processor failed");
    expect(dump).not.toContain("bullmq.job.failed.reason");
    expect(dump).not.toContain("bullmq.job.result");
    expect(dump).not.toContain("bullmq.job.progress");
  });

  it("captures a terminal failed attempt with the producer trace", async () => {
    spanExporter.reset();

    const job = await queue.add("probe", { fail: true }, { attempts: 1 });
    await firstFailed.promise;
    await vi.waitFor(async () => {
      expect(await job.getState()).toBe("failed");
    });

    expect(captureException).toHaveBeenCalledTimes(1);

    const producer = spanExporter.getFinishedSpans().find((span) => span.name.startsWith("add "));
    expect(producer).toBeDefined();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        message: "BullMQ job failed terminally",
        tags: expect.objectContaining({
          "error.source": "bullmq",
          "job.name": "probe",
          "queue.name": QUEUE_NAME,
        }),
        traceContext: expect.objectContaining({
          traceId: producer?.spanContext().traceId,
        }),
      }),
    );
  });

  it("does not capture a retryable failure, then captures the terminal attempt", async () => {
    const job = await queue.add("probe", { fail: true }, { attempts: 2 });
    await firstFailed.promise;
    expect(captureException).not.toHaveBeenCalled();

    await secondFailed.promise;
    await vi.waitFor(async () => {
      expect(await job.getState()).toBe("failed");
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        message: "BullMQ job failed terminally",
      }),
    );
  });
});
