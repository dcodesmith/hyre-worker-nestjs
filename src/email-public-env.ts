/**
 * Small subset of process.env for email rendering (matches hireApp pattern).
 */
export function getEmailPublicEnv() {
  return {
    appName: process.env.APP_NAME ?? "Tripdly",
    domain: process.env.DOMAIN ?? "https://tripdly.com",
    websiteUrl: process.env.WEBSITE_URL ?? process.env.DOMAIN ?? "https://tripdly.com",
    supportEmail: process.env.SUPPORT_EMAIL ?? "support@tripdly.com",
    companyAddress: process.env.COMPANY_ADDRESS ?? "Lagos, Nigeria",
  };
}
