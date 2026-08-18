const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS = 10 * 60;
const LEGACY_PBKDF2_ITERATIONS = 310_000;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;

const encoder = new TextEncoder();

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index % a.length] || 0) ^ (b[index % b.length] || 0);
  return difference === 0;
}

async function derivePassword(password, salt, iterations = LEGACY_PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    material,
    256,
  );
  return base64url(new Uint8Array(bits));
}

async function hmacPassword(password, salt, pepper) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${salt}\0${password}`));
  return base64url(new Uint8Array(signature));
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 256;
}

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
  } catch {
    return false;
  }
}

function oauthError(error, description, status = 400) {
  return json({ error, error_description: description }, status);
}

export class AuthStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return oauthError("invalid_request", "Invalid JSON body.");
      }
    }

    if (url.pathname === "/setup/status") {
      return json({ configured: Boolean(await this.ctx.storage.get("password")) });
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      if (!this.env.OAUTH_SETUP_TOKEN || !constantTimeEqual(request.headers.get("x-setup-token") || "", this.env.OAUTH_SETUP_TOKEN)) {
        return oauthError("access_denied", "Invalid setup token.", 403);
      }
      if (await this.ctx.storage.get("password")) return oauthError("access_denied", "Password has already been initialized.", 409);
      if (!validPassword(body.password)) return oauthError("invalid_request", "Password must contain 12 to 256 characters.");
      if (!this.env.OAUTH_PASSWORD_PEPPER) return oauthError("server_error", "Password protection secret is not configured.", 500);
      const salt = randomToken(24);
      await this.ctx.storage.put("password", {
        salt,
        scheme: "hmac-sha256-pepper-v1",
        hash: await hmacPassword(body.password, salt, this.env.OAUTH_PASSWORD_PEPPER),
        createdAt: Date.now(),
      });
      return json({ ok: true });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      const redirectUris = Array.isArray(body.redirect_uris) ? [...new Set(body.redirect_uris.map(String))] : [];
      if (!redirectUris.length || redirectUris.length > 20 || redirectUris.some((uri) => !validRedirectUri(uri))) {
        return oauthError("invalid_redirect_uri", "At least one valid HTTPS redirect URI is required.");
      }
      const clientId = `chatgpt_${randomToken(24)}`;
      const client = {
        client_id: clientId,
        client_name: String(body.client_name || "OpenAI MCP client").slice(0, 200),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      await this.ctx.storage.put(`client:${clientId}`, client);
      return json(client, 201);
    }

    if (url.pathname === "/authorize" && request.method === "POST") return this.authorize(body, request);
    if (url.pathname === "/token" && request.method === "POST") return this.token(body);
    if (url.pathname === "/verify" && request.method === "POST") return this.verify(body.token);
    if (url.pathname === "/revoke" && request.method === "POST") return this.revoke(body.token);
    if (url.pathname === "/revoke-all" && request.method === "POST") return this.revokeAll(body.password, request);

    return new Response("Not found", { status: 404 });
  }

  async verifyPassword(password) {
    const saved = await this.ctx.storage.get("password");
    if (!saved || !validPassword(password)) return false;
    if (saved.scheme === "hmac-sha256-pepper-v1") {
      if (!this.env.OAUTH_PASSWORD_PEPPER) return false;
      return constantTimeEqual(await hmacPassword(password, saved.salt, this.env.OAUTH_PASSWORD_PEPPER), saved.hash);
    }
    return constantTimeEqual(await derivePassword(password, saved.salt, saved.iterations || LEGACY_PBKDF2_ITERATIONS), saved.hash);
  }

  async checkLoginRateLimit(request) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const key = `attempt:${await sha256(ip)}`;
    const now = Date.now();
    const record = await this.ctx.storage.get(key);
    if (!record || now - record.startedAt >= LOGIN_WINDOW_SECONDS * 1000) return { allowed: true, key, record: { startedAt: now, count: 0 } };
    return { allowed: record.count < MAX_LOGIN_ATTEMPTS, key, record };
  }

  async authorize(body, request) {
    const client = await this.ctx.storage.get(`client:${String(body.client_id || "")}`);
    if (!client) return oauthError("unauthorized_client", "Unknown OAuth client.", 401);
    if (!client.redirect_uris.includes(body.redirect_uri)) return oauthError("invalid_grant", "Redirect URI does not match the registered client.");
    if (body.response_type !== "code") return oauthError("unsupported_response_type", "Only the authorization code flow is supported.");
    if (body.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(String(body.code_challenge || ""))) {
      return oauthError("invalid_request", "PKCE with the S256 method is required.");
    }

    const limit = await this.checkLoginRateLimit(request);
    if (!limit.allowed) return oauthError("temporarily_unavailable", "Too many failed attempts. Try again in 15 minutes.", 429);
    if (!(await this.verifyPassword(body.password))) {
      await this.ctx.storage.put(limit.key, { ...limit.record, count: limit.record.count + 1 }, { expirationTtl: LOGIN_WINDOW_SECONDS });
      return oauthError("access_denied", "Password is incorrect.", 401);
    }
    await this.ctx.storage.delete(limit.key);

    const code = randomToken(32);
    await this.ctx.storage.put(`code:${await sha256(code)}`, {
      clientId: client.client_id,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      resource: body.resource,
      scope: "device.control",
      expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
    }, { expirationTtl: AUTH_CODE_TTL_SECONDS });
    return json({ code });
  }

  async issueTokens(clientId, scope, previousRefreshHash) {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(48);
    const now = Date.now();
    const accessHash = await sha256(accessToken);
    const refreshHash = await sha256(refreshToken);
    await this.ctx.storage.put(`access:${accessHash}`, { clientId, scope, expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000 }, { expirationTtl: ACCESS_TOKEN_TTL_SECONDS });
    await this.ctx.storage.put(`refresh:${refreshHash}`, { clientId, scope, expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000 }, { expirationTtl: REFRESH_TOKEN_TTL_SECONDS });
    if (previousRefreshHash) await this.ctx.storage.delete(`refresh:${previousRefreshHash}`);
    return json({
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    });
  }

  async token(body) {
    const clientId = String(body.client_id || "");
    const client = await this.ctx.storage.get(`client:${clientId}`);
    if (!client) return oauthError("invalid_client", "Unknown OAuth client.", 401);

    if (body.grant_type === "authorization_code") {
      const codeHash = await sha256(String(body.code || ""));
      const record = await this.ctx.storage.get(`code:${codeHash}`);
      if (!record) return oauthError("invalid_grant", "Authorization code is invalid or expired.");
      await this.ctx.storage.delete(`code:${codeHash}`);
      if (record.expiresAt < Date.now() || record.clientId !== clientId || record.redirectUri !== body.redirect_uri || record.resource !== body.resource) {
        return oauthError("invalid_grant", "Authorization code binding does not match.");
      }
      const challenge = await sha256(String(body.code_verifier || ""));
      if (!constantTimeEqual(challenge, record.codeChallenge)) return oauthError("invalid_grant", "PKCE verification failed.");
      return this.issueTokens(clientId, record.scope);
    }

    if (body.grant_type === "refresh_token") {
      const refreshHash = await sha256(String(body.refresh_token || ""));
      const record = await this.ctx.storage.get(`refresh:${refreshHash}`);
      if (!record || record.expiresAt < Date.now() || record.clientId !== clientId) return oauthError("invalid_grant", "Refresh token is invalid or expired.");
      return this.issueTokens(clientId, record.scope, refreshHash);
    }

    return oauthError("unsupported_grant_type", "Supported grants are authorization_code and refresh_token.");
  }

  async verify(token) {
    if (!token) return json({ active: false });
    const record = await this.ctx.storage.get(`access:${await sha256(String(token))}`);
    if (!record || record.expiresAt < Date.now()) return json({ active: false });
    return json({ active: true, client_id: record.clientId, scope: record.scope, exp: Math.floor(record.expiresAt / 1000) });
  }

  async revoke(token) {
    if (token) {
      const hash = await sha256(String(token));
      await Promise.all([this.ctx.storage.delete(`access:${hash}`), this.ctx.storage.delete(`refresh:${hash}`)]);
    }
    return new Response(null, { status: 200 });
  }

  async revokeAll(password, request) {
    const limit = await this.checkLoginRateLimit(request);
    if (!limit.allowed) return oauthError("temporarily_unavailable", "Too many failed attempts. Try again later.", 429);
    if (!(await this.verifyPassword(password))) {
      await this.ctx.storage.put(limit.key, { ...limit.record, count: limit.record.count + 1 }, { expirationTtl: LOGIN_WINDOW_SECONDS });
      return oauthError("access_denied", "Password is incorrect.", 401);
    }
    const tokens = await this.ctx.storage.list({ prefix: "access:" });
    const refreshTokens = await this.ctx.storage.list({ prefix: "refresh:" });
    await this.ctx.storage.delete([...tokens.keys(), ...refreshTokens.keys()]);
    return json({ ok: true, revoked: tokens.size + refreshTokens.size });
  }
}

export function authStore(env) {
  return env.AUTH_STORE.get(env.AUTH_STORE.idFromName("single-user-auth"));
}

export async function verifyBearer(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return false;
  const response = await authStore(env).fetch("https://auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return Boolean((await response.json()).active);
}
