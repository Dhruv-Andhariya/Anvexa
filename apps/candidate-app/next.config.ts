import type { NextConfig } from 'next';

// Same convention as apps/careers-site: the API's internal URL, including /api/v1.
const apiUrl = (process.env.API_INTERNAL_URL || 'http://localhost:4000/api/v1').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  // For a public link (e.g. a Cloudflare quick tunnel) the browser calls THIS site (build with
  // NEXT_PUBLIC_API_URL=/api/v1) and the site forwards the candidate DSA routes to the API. Only
  // /api/v1/dsa/* is forwarded: the proctoring admin routes (/dsa-admin/*), the rest of the API and Judge0 are
  // never reachable through this site.
  async rewrites() {
    return [{ source: '/api/v1/dsa/:path*', destination: `${apiUrl}/dsa/:path*` }];
  },
  // Next.js cuts a proxied request off after 30 s by default (HTTP 500), but a Submit can legitimately take longer
  // when many candidates submit at once and their runs queue for the code runner (measured: up to ~2 minutes for 20
  // simultaneous C++ submissions). The backend bounds the wait itself (DSA_RUNNER_QUEUE_TIMEOUT_MS).
  experimental: { proxyTimeout: 240_000 },
  // The page URL holds the candidate's personal token: never sent on as a referrer, never cached or indexed.
  // The webcam (proctoring; the video is never recorded) and full screen may only be used by this site itself.
  async headers() {
    return [
      {
        source: '/dsa/:token*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), fullscreen=(self)' },
        ],
      },
    ];
  },
  // Dev server opened through a Cloudflare quick tunnel or ngrok: allow its JS / HMR requests.
  allowedDevOrigins: ['*.trycloudflare.com', '*.ngrok-free.app', '*.ngrok-free.dev', '*.ngrok.app'],
};

export default nextConfig;
