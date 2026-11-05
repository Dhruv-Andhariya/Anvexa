import type { NextConfig } from "next";

// The API's internal URL, including /api/v1 (same convention as apps/careers-site).
const apiUrl = (process.env.API_INTERNAL_URL || "http://localhost:4000/api/v1").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // The browser calls the API through THIS site (lib/api.ts uses /api/v1 by default), so the dashboard works the same
  // on http://localhost:3000 and through a public tunnel, and the session cookie stays first-party (no CORS).
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/:path*` }];
  },
  // Dev server opened through a Cloudflare quick tunnel: allow its JS / HMR requests.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
