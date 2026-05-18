/**
 * Custom JWT validation middleware for Teams webhook requests.
 *
 * Validates Bearer tokens from Microsoft Bot Framework / Entra ID
 * BEFORE body parsing, so unauthenticated requests are rejected early.
 */

import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

// Microsoft JWKS endpoints
const BOT_FRAMEWORK_JWKS_URI = 'https://login.botframework.com/v1/.well-known/keys';

function getEntraJwksUri(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
}

// Accepted issuers
const BOT_FRAMEWORK_ISSUERS = [
  'https://api.botframework.com',
  'https://sts.windows.net/',
];

function getEntraIssuer(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

/**
 * Create a JWT validation middleware.
 *
 * @param {object} options
 * @param {string} options.appId - The bot's Microsoft App ID (audience claim)
 * @param {string} [options.tenantId] - Optional tenant ID for single-tenant validation
 * @returns {function} Express middleware
 */
export function createJwtMiddleware({ appId, tenantId } = {}) {
  if (!appId) {
    console.warn('[ms-teams/auth] No appId provided, JWT validation will reject all requests');
  }

  // Create JWKS clients with built-in caching
  const botFrameworkJwksClient = jwksRsa({
    jwksUri: BOT_FRAMEWORK_JWKS_URI,
    cache: true,
    cacheMaxAge: 24 * 60 * 60 * 1000, // 24 hours
    rateLimit: true,
    jwksRequestsPerMinute: 5,
  });

  let entraJwksClient = null;
  if (tenantId) {
    entraJwksClient = jwksRsa({
      jwksUri: getEntraJwksUri(tenantId),
      cache: true,
      cacheMaxAge: 24 * 60 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
    });
  }

  // Build accepted issuers list
  const acceptedIssuers = [...BOT_FRAMEWORK_ISSUERS];
  if (tenantId) {
    acceptedIssuers.push(getEntraIssuer(tenantId));
    // Legacy issuer format with tenant ID
    acceptedIssuers.push(`https://sts.windows.net/${tenantId}/`);
  }

  /**
   * Get signing key from JWKS.
   * Tries Bot Framework endpoint first, then tenant-specific if configured.
   */
  function getSigningKey(header) {
    return new Promise((resolve, reject) => {
      botFrameworkJwksClient.getSigningKey(header.kid, (err, key) => {
        if (!err && key) {
          resolve(key.getPublicKey());
          return;
        }
        // Try Entra ID endpoint if Bot Framework didn't have the key
        if (entraJwksClient) {
          entraJwksClient.getSigningKey(header.kid, (err2, key2) => {
            if (err2 || !key2) {
              reject(err2 || new Error('Key not found in any JWKS endpoint'));
              return;
            }
            resolve(key2.getPublicKey());
          });
          return;
        }
        reject(err || new Error('Key not found'));
      });
    });
  }

  /**
   * Verify a JWT token.
   */
  async function verifyToken(token) {
    // Decode header to get kid
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header) {
      throw new Error('Invalid token: cannot decode header');
    }

    const signingKey = await getSigningKey(decoded.header);

    return new Promise((resolve, reject) => {
      jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        audience: appId,
        // Issuer is checked manually below for flexible matching
        clockTolerance: 300, // 5 minute tolerance
      }, (err, payload) => {
        if (err) {
          reject(err);
          return;
        }

        // Validate issuer (accept prefix match for STS issuer format)
        const tokenIssuer = payload.iss || '';
        const issuerValid = acceptedIssuers.some(accepted =>
          tokenIssuer === accepted || tokenIssuer.startsWith(accepted)
        );

        if (!issuerValid) {
          reject(new Error(`Invalid issuer: ${tokenIssuer}`));
          return;
        }

        resolve(payload);
      });
    });
  }

  /**
   * Express middleware — runs BEFORE body parsing.
   * Reads only the Authorization header; does not consume the request body.
   */
  return async function jwtValidation(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (!token) {
      res.status(401).json({ error: 'Empty Bearer token' });
      return;
    }

    try {
      const payload = await verifyToken(token);
      // Attach validated claims to request for downstream use
      req.jwtPayload = payload;
      next();
    } catch (err) {
      console.warn(`[ms-teams/auth] JWT validation failed: ${err.message}`);
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}
