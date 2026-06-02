/**
 * Custom JWT validation middleware for Teams webhook requests.
 *
 * Validates Bearer tokens from Microsoft Bot Framework / Entra ID
 * BEFORE body parsing, so unauthenticated requests are rejected early.
 */

import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { getCloudConfig } from './cloud.js';
import { appendErrorHint } from './errors.js';

function getEntraJwksUri(tenantId, cloud) {
  return `https://${cloud.loginHost}/${tenantId}/discovery/v2.0/keys`;
}

function getEntraIssuer(tenantId, cloud) {
  return `https://${cloud.loginHost}/${tenantId}/v2.0`;
}

/**
 * Create a JWT validation middleware.
 *
 * @param {object} options
 * @param {string} options.appId - The bot's Microsoft App ID (audience claim)
 * @param {string} [options.tenantId] - Optional tenant ID for single-tenant validation
 * @param {string} [options.cloud] - Microsoft cloud: public | gccHigh | dod | china
 * @returns {function} Express middleware
 */
export function createJwtMiddleware({ appId, tenantId, cloud: cloudName = 'public' } = {}) {
  const cloud = getCloudConfig(cloudName);
  if (!appId) {
    console.warn('[ms-teams/auth] No appId provided, JWT validation will reject all requests');
  }

  // Create JWKS clients with built-in caching
  const botFrameworkJwksClient = jwksRsa({
    jwksUri: cloud.botFrameworkJwksUri,
    cache: true,
    cacheMaxAge: 24 * 60 * 60 * 1000, // 24 hours
    rateLimit: true,
    jwksRequestsPerMinute: 5,
  });

  let entraJwksClient = null;
  if (tenantId) {
    entraJwksClient = jwksRsa({
      jwksUri: getEntraJwksUri(tenantId, cloud),
      cache: true,
      cacheMaxAge: 24 * 60 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
    });
  }

  const acceptedIssuerRules = buildAcceptedIssuerRules({ tenantId, cloud });

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

        // Validate issuer. Broad STS issuer matching is only kept for
        // multi-tenant mode; single-tenant mode requires the tenant-qualified
        // legacy issuer.
        const tokenIssuer = payload.iss || '';
        const issuerValid = isIssuerAccepted(tokenIssuer, acceptedIssuerRules);

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
      console.warn(`[ms-teams/auth] ${appendErrorHint(`JWT validation failed: ${err.message}`, { error: err })}`);
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

function buildAcceptedIssuerRules({ tenantId, cloud }) {
  const rules = [];
  if (cloud.botFrameworkIssuer) {
    rules.push({ issuer: cloud.botFrameworkIssuer, prefix: false });
  }
  if (tenantId) {
    rules.push({ issuer: getEntraIssuer(tenantId, cloud), prefix: false });
    if (cloud.legacyStsIssuer) {
      rules.push({ issuer: `${cloud.legacyStsIssuer}${tenantId}/`, prefix: false });
    }
  } else if (cloud.legacyStsIssuer) {
    rules.push({ issuer: cloud.legacyStsIssuer, prefix: true });
  }
  return rules;
}

function isIssuerAccepted(tokenIssuer, rules) {
  return rules.some(rule => (
    rule.prefix
      ? String(tokenIssuer || '').startsWith(rule.issuer)
      : tokenIssuer === rule.issuer
  ));
}

export function _isIssuerAcceptedForTest({ issuer, tenantId = '', cloud: cloudName = 'public' }) {
  const cloud = getCloudConfig(cloudName);
  return isIssuerAccepted(issuer, buildAcceptedIssuerRules({ tenantId, cloud }));
}
