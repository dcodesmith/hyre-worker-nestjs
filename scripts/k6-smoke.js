import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const fixtureSkips = new Counter("fixture_skips");

const BLOCKED_HOSTS = new Set([
  "tripdly.com",
  "www.tripdly.com",
  "hyre-worker-nestjs.fly.dev",
  "hyre-worker-nestjs-production.fly.dev",
]);

const FORBIDDEN_PATHS = [
  /^\/api\/auth(?:\/|$)/,
  /^\/auth(?:\/|$)/,
  /^\/api\/bookings(?:\/|$)/,
  /^\/api\/payments(?:\/|$)/,
  /verification/i,
  /^\/api\/places(?:\/|$)/,
  /^\/api\/calculate-trip-duration$/,
  /^\/api\/search-flight$/,
  /^\/api\/ai-search$/,
  /webhook/i,
  /notification/i,
];

const API_ORIGIN = previewOrigin(__ENV.API_BASE_URL);
const EXPECTED_API_COMMIT = requiredSha("EXPECTED_API_COMMIT");
const EXPECTED_API_VERSION = requiredValue("EXPECTED_API_VERSION");

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
  },
};

export default function () {
  const runId = `k6-api-smoke-${Date.now()}-${__VU}-${__ITER}`;
  const headers = {
    Accept: "application/json",
    Origin: API_ORIGIN,
    "X-Client-Type": "mobile",
    "x-request-id": runId,
  };

  const identity = safeRequest("GET", "/", null, headers, "deployment_identity");
  check(identity, {
    "API identity is healthy": (response) => response.status === 200,
    "preview environment is selected": (response) => response.json("environment") === "preview",
    "API commit matches": (response) =>
      response.json("deployment.commit") === EXPECTED_API_COMMIT,
    "API version matches": (response) =>
      response.json("deployment.version") === EXPECTED_API_VERSION,
  });

  const health = safeRequest("GET", "/health", null, headers, "health");
  check(health, {
    "health is OK": (response) =>
      response.status === 200 && response.json("status") === "ok",
  });

  const categories = safeRequest(
    "GET",
    "/api/cars/categories?limit=20",
    null,
    headers,
    "categories",
  );
  check(categories, {
    "categories are readable": (response) =>
      response.status === 200 && Array.isArray(response.json("allCars")),
  });

  const search = safeRequest(
    "GET",
    "/api/cars/search?bookingType=DAY&page=1&limit=12",
    null,
    headers,
    "cars_search",
  );
  check(search, {
    "car search succeeds": (response) => response.status === 200,
  });

  const rates = safeRequest("GET", "/api/rates", null, headers, "rates");
  check(rates, {
    "rates are readable": (response) =>
      response.status === 200 &&
      Number.isFinite(response.json("platformCustomerServiceFeeRatePercent")) &&
      Number.isFinite(response.json("vatRatePercent")),
  });

  const car = firstCar(categories);
  if (!car) {
    fixtureSkips.add(1, { flow: "car_detail_and_pricing" });
    console.warn("SKIP car detail and pricing preview: categories returned no fixture car");
    return;
  }

  const carDetail = safeRequest(
    "GET",
    `/api/cars/${car.id}`,
    null,
    headers,
    "car_detail",
  );
  check(carDetail, {
    "car detail succeeds": (response) =>
      response.status === 200 && response.json("id") === car.id,
  });

  const pricingPreview = safeRequest(
    "POST",
    "/api/bookings/pricing-preview",
    JSON.stringify(pricingPreviewBody(car.id)),
    { ...headers, "Content-Type": "application/json" },
    "pricing_preview",
  );
  check(pricingPreview, {
    "pricing preview is read-only and succeeds": (response) =>
      response.status === 200 && Number.isFinite(response.json("totalAmount")),
  });
}

function safeRequest(method, path, body, headers, name) {
  assertAllowed(method, path);
  const params = {
    headers,
    redirects: 0,
    tags: { endpoint: name, surface: "api" },
    timeout: "15s",
  };

  return method === "POST"
    ? http.post(`${API_ORIGIN}${path}`, body, params)
    : http.get(`${API_ORIGIN}${path}`, params);
}

function assertAllowed(method, path) {
  const url = new URL(path, "https://smoke.invalid");
  const pathname = url.pathname;
  const isPricingPreview = pathname === "/api/bookings/pricing-preview";

  if (!isPricingPreview && FORBIDDEN_PATHS.some((pattern) => pattern.test(pathname))) {
    throw new Error(`Refusing forbidden smoke endpoint: ${method} ${pathname}`);
  }

  const allowed =
    (method === "GET" &&
      (pathname === "/" ||
        pathname === "/health" ||
        pathname === "/api/cars/categories" ||
        pathname === "/api/cars/search" ||
        pathname === "/api/rates" ||
        /^\/api\/cars\/[0-9a-f-]{36}$/.test(pathname))) ||
    (method === "POST" && isPricingPreview);

  if (!allowed) {
    throw new Error(`Endpoint is not on the read-only smoke allowlist: ${method} ${pathname}`);
  }
}

function previewOrigin(rawValue) {
  const raw = requiredValue("API_BASE_URL", rawValue);
  const url = new URL(raw);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("API_BASE_URL must be a bare HTTPS origin");
  }

  if (BLOCKED_HOSTS.has(url.hostname) || url.hostname.includes("production")) {
    throw new Error(`Refusing production hostname: ${url.hostname}`);
  }

  if (!/^hyre-worker-nestjs-pr-\d+\.fly\.dev$/.test(url.hostname)) {
    throw new Error(`Refusing non-preview API hostname: ${url.hostname}`);
  }

  return url.origin;
}

function requiredValue(name, suppliedValue = __ENV[name]) {
  const value = suppliedValue?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredSha(name) {
  const value = requiredValue(name);
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} must be a full git SHA`);
  }
  return value;
}

function firstCar(response) {
  if (response.status !== 200) {
    return null;
  }

  const cars = response.json("allCars");
  const car = Array.isArray(cars) ? cars[0] : null;
  if (!car || typeof car.id !== "string" || !/^[0-9a-f-]{36}$/i.test(car.id)) {
    return null;
  }
  return car;
}

function pricingPreviewBody(carId) {
  const { startDate, endDate } = futureDayWindow();
  return {
    carId,
    bookingType: "DAY",
    startDate,
    endDate,
    pickupTime: "9 AM",
    addonIds: [],
    requiresFullTank: false,
    useCredits: 0,
  };
}

function futureDayWindow() {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 45);
  start.setUTCHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setUTCHours(20, 0, 0, 0);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}
