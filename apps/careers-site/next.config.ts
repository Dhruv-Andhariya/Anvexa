import type { NextConfig } from "next";

const apiUrl = (process.env.API_INTERNAL_URL || "http://localhost:4000/api/v1").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // Students' browsers call the API through this site (lib/api.ts). Only the public candidate routes are
  // proxied - HR routes of the API are never reachable through the careers site.
  // This proxy forwards the visitor's headers unchanged and adds no X-Forwarded-For of its own; src/middleware.ts
  // sets X-Forwarded-For from TRUSTED_CLIENT_IP_HEADER (or removes it) so the API's per-IP limits cannot be faked.
  async rewrites() {
    return [{ source: "/api/v1/public/:path*", destination: `${apiUrl}/public/:path*` }];
  },
  // M12 AI screening page: the URL holds the candidate's personal link token. Never sent on as a referrer, never
  // cached or indexed; the microphone may only be used by this site itself.
  async headers() {
    return [
      {
        source: "/screening/:token*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=()" },
        ],
      },
      // M13 online assessment page: same rules for its personal link; the webcam (preview only) may be used here.
      {
        source: "/assessment/:token*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), fullscreen=(self)" },
        ],
      },
    ];
  },
  // Demo: dev server opened through a Cloudflare quick tunnel or an ngrok static domain - allow its JS/HMR requests.
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app"],
};

export default nextConfig;
