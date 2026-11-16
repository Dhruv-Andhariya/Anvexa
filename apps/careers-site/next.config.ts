import type { NextConfig } from "next";

const apiUrl = (process.env.API_INTERNAL_URL || "http://localhost:4000/api/v1").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // Students' browsers call the API through this site (lib/api.ts). Only the public candidate routes are
  // proxied - HR routes of the API are never reachable through the careers site.
  // This proxy forwards the visitor's headers unchanged and adds no X-Forwarded-For of its own; src/middleware.ts
  // sets X-Forwarded-For from TRUSTED_CLIENT_IP_HEADER (or removes it) so the API's per-IP limits cannot be faked.
  // The DSA / SQL coding page (/dsa/[token], lib/dsa-api.ts) uses the API's candidate DSA routes: only /api/v1/dsa/*
  // is forwarded for it - the proctoring admin routes (/dsa-admin/*) and the code runner are never reachable here.
  async rewrites() {
    return [
      { source: "/api/v1/public/:path*", destination: `${apiUrl}/public/:path*` },
      { source: "/api/v1/dsa/:path*", destination: `${apiUrl}/dsa/:path*` },
    ];
  },
  // Next.js cuts a proxied request off after 30 s by default (HTTP 500), but a DSA Submit can legitimately take longer
  // when many candidates submit at once and their runs queue for the code runner (measured: up to ~2 minutes for 20
  // simultaneous C++ submissions). The backend bounds the wait itself (DSA_RUNNER_QUEUE_TIMEOUT_MS).
  experimental: { proxyTimeout: 240_000 },
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
      // AI technical interview page: same rules for its personal link; camera (preview only) and microphone are needed.
      {
        source: "/interview/:token*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), autoplay=(self), fullscreen=(self)" },
        ],
      },
      // DSA / SQL coding page: same rules for its personal link; the webcam (proctoring; never recorded) and full screen.
      {
        source: "/dsa/:token*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), fullscreen=(self)" },
        ],
      },
      // M18 group discussion page: same rules for its personal link; camera and microphone are needed (live video room).
      {
        source: "/gd/:token*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), fullscreen=(self), autoplay=(self)" },
        ],
      },
    ];
  },
  // Demo: dev server opened through a Cloudflare quick tunnel or an ngrok static domain - allow its JS/HMR requests.
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app"],
};

export default nextConfig;
