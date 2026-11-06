import { describe, expect, it } from 'vitest';
import { GoogleOAuthClient, googleMode, googleOAuthConfigFromEnv, newGoogleState, readGoogleState } from '../src/modules/auth/google-oauth';

const PUBLIC = 'https://joins-liable-genius-resistance.trycloudflare.com';
const env = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:4000/api/v1/auth/google/callback',
  HR_DASHBOARD_URL: PUBLIC,
} as NodeJS.ProcessEnv;
const client = () => new GoogleOAuthClient(googleOAuthConfigFromEnv(env));

describe('Google sign-in returns through the dashboard address HR is using', () => {
  it('public address (tunnel): Google returns through that address and HR lands there', () => {
    expect(client().flowFor('joins-liable-genius-resistance.trycloudflare.com')).toEqual({
      dashboardUrl: PUBLIC,
      redirectUri: `${PUBLIC}/api/v1/auth/google/callback`,
    });
    const url = new URL(client().authorizeUrl('s', 'v', `${PUBLIC}/api/v1/auth/google/callback`));
    expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/v1/auth/google/callback`);
  });

  it('this computer (localhost:3000): the registered localhost callback, and HR lands back on localhost:3000', () => {
    expect(client().flowFor('localhost:3000')).toEqual({ dashboardUrl: 'http://localhost:3000', redirectUri: env.GOOGLE_REDIRECT_URI });
  });

  it('an unknown host never becomes a redirect target (no open redirect)', () => {
    expect(client().flowFor('evil.example.com')).toEqual({ dashboardUrl: PUBLIC, redirectUri: env.GOOGLE_REDIRECT_URI });
    expect(client().flowFor(undefined).dashboardUrl).toBe(PUBLIC);
  });

  it('the state cookie carries the flow; a tampered flow is refused', () => {
    const flow = client().flowFor('joins-liable-genius-resistance.trycloudflare.com');
    const { state, cookie } = newGoogleState('/jobs', true, flow);
    const value = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
    const read = readGoogleState(value, state)!;
    expect(read.next).toBe('/jobs');
    expect(client().knownFlow(read.flow)).toEqual(flow);
    expect(client().knownFlow({ dashboardUrl: 'https://evil.example.com', redirectUri: 'https://evil.example.com/api/v1/auth/google/callback' })).toBeNull();
    expect(client().knownFlow({ dashboardUrl: PUBLIC, redirectUri: 'https://evil.example.com/cb' })).toBeNull();
  });

  it('old state cookies (without a flow) still work with the configured default', () => {
    const { state, cookie } = newGoogleState(undefined, false);
    const read = readGoogleState(decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!), state)!;
    expect(read.flow).toBeUndefined();
    expect(client().knownFlow(read.flow)).toBeNull();
  });

  it('the state cookie remembers login vs sign-up; anything but "signup" is a login', () => {
    const value = (cookie: string) => decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
    const flow = client().flowFor('localhost:3000');
    const signup = newGoogleState('/jobs', false, flow, 'signup');
    expect(readGoogleState(value(signup.cookie), signup.state)).toMatchObject({ mode: 'signup', next: '/jobs', flow });
    const noFlow = newGoogleState(undefined, false, undefined, 'signup');
    expect(readGoogleState(value(noFlow.cookie), noFlow.state)).toMatchObject({ mode: 'signup', flow: undefined });
    const login = newGoogleState(undefined, false);
    expect(readGoogleState(value(login.cookie), login.state)!.mode).toBe('login');
    // a cookie from before this change (state.verifier.next.dash.redirect, no mode) is a login
    const old = [signup.state, 'verifier', '', '', ''].join('.');
    expect(readGoogleState(old, signup.state)!.mode).toBe('login');
    expect(googleMode('SIGNUP')).toBe('login');
    expect(googleMode(undefined)).toBe('login');
  });
});
