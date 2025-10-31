const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = 5001;

// Custom middleware to capture raw body AND parse JSON for signature validation
app.use('/action', express.raw({type: 'application/json'}), (req, res, next) => {
  // Store the raw body for signature validation
  req.rawBody = req.body.toString('utf8');
  
  // Parse the JSON manually and attach it to req.body
  try {
    req.body = JSON.parse(req.rawBody);
  } catch (error) {
    console.error('JSON parsing error:', error);
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  
  next();
});

// --- Helpers ---

const ZITADEL_DOMAIN = process.env.ZITADEL_DOMAIN;   // e.g. "auth.example.com"
const accessToken  = process.env.ACCESS_TOKEN;   // PAT or service-user access-token

/**
 * Validates Zitadel webhook signature
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} signingKey - The signing key for this specific endpoint
 * @returns {boolean} - Returns true if validation passes, sends error response and returns false if validation fails
 */
function validateZitadelSignature(req, res, signingKey) {
  // Get the webhook signature
  const signatureHeader = req.headers['zitadel-signature'];
  if (!signatureHeader) {
    console.error("Missing signature");
    res.status(400).send('Missing signature');
    return false;
  }

  // Validate the webhook signature
  const elements = signatureHeader.split(',');
  const timestampElement = elements.find(e => e.startsWith('t='));
  const signatureElement = elements.find(e => e.startsWith('v1='));
  
  if (!timestampElement || !signatureElement) {
    console.error("Invalid signature format");
    res.status(400).send('Invalid signature format');
    return false;
  }
  
  const timestamp = timestampElement.split('=')[1];
  const signature = signatureElement.split('=')[1];
  const signedPayload = `${timestamp}.${req.rawBody}`;
  const hmac = crypto.createHmac('sha256', signingKey)
    .update(signedPayload)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(hmac),
    Buffer.from(signature)
  );

  if (!isValid) {
    console.error("Invalid signature");
    res.status(403).send('Invalid signature');
    return false;
  }

  console.info("Signature validation successful");
  return true;
}

async function zFetch(path, init = {}) {
  const res = await fetch(`https://${ZITADEL_DOMAIN}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Zitadel API ${path} failed: ${res.status} ${res.statusText} ${txt}`);
  }
  return res.json();
}

function generateRandomPassword() {
  const length = 8;
  const charset = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    symbol: '!@#$%^&*()_+[]{}|;:,.<>?',
    number: '0123456789'
  };

  let password = '';
  password += charset.lower[Math.floor(Math.random() * charset.lower.length)];
  password += charset.upper[Math.floor(Math.random() * charset.upper.length)];
  password += charset.symbol[Math.floor(Math.random() * charset.symbol.length)];
  password += charset.number[Math.floor(Math.random() * charset.number.length)];

  const allChars = charset.lower + charset.upper + charset.symbol + charset.number;
  while (password.length < length) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  return password.split('').sort(() => Math.random() - 0.5).join(''); // Shuffle the password
}

async function createUserFromLegacy(legacy) {
  const body = {
    organizationId: process.env.ZITADEL_ORG_ID,
    userId: legacy.userId,
    username: legacy.username,
    human: {
      profile: {
      givenName: legacy.givenName,
      familyName: legacy.familyName,
      displayName: legacy.displayName,
      preferredLanguage: legacy.preferredLanguage || "en"
      },
    email: {
      email: legacy.email,
      isVerified: true
      },
    password: {
      password: generateRandomPassword(),
      changeRequired: false
    },
    metadata: [{ key: "migratedFromLegacy", value: Buffer.from("migrating").toString("base64") }]
    }
  };
  const resp = await zFetch('/v2/users/new', { method: 'POST', body: JSON.stringify(body) });
  return resp.id;
}

async function setUserPassword(userId, pw) {
  const body = { human: { password: { password: { password: pw, changeRequired: false } } } };
  await zFetch(`/v2/users/${userId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/**
 * Retrieves and checks user metadata for migration status.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<{ migrated: boolean, metadata: Array }>} - Migration status and metadata.
 */
async function getUserMigrationMetadata(userId) {
  const metadataSearchBody = {
    filters: [
      {
        keyFilter: {
          key: "migratedFromLegacy",
          method: "TEXT_FILTER_METHOD_EQUALS"
        }
      }
    ]
  };

  const metadataSearchResponse = await zFetch(`/v2/users/${userId}/metadata/search`, {
    method: 'POST',
    body: JSON.stringify(metadataSearchBody)
  });

  const metadata = metadataSearchResponse.metadata || [];
  const migratedMetadata = metadata.find(m => m.key === 'migratedFromLegacy');
  const migratedValue = migratedMetadata ? Buffer.from(migratedMetadata.value, 'base64').toString('utf8') : null;

  return {
    migrated: migratedValue === 'true',
    metadata
  };
}

// --- Mock "Legacy" directory (replace with real calls later) ---
const LEGACY_DB = {
  "legacy-user@gmail.com": {
    userId: "db-163840776835432346",
    username: "legacy-user",
    givenName: "Legacy",
    familyName: "User",
    displayName: "Legacy User",
    preferredLanguage: "en",
    email: "legacy-user@gmail.com",
    password: "Password1!"
  }
};

// --- Response Action (restCall): ListUsers ---
app.post('/action/list-users', async (req, res) => {
  // Validate signature first
  const LISTUSERS_SIGNING_KEY = process.env.LISTUSERS_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, LISTUSERS_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

  try {
    const body = req.body || {};
    const resp = body.response || {};
    const userID = body.userID;

    // We only want to handle requests from the hosted login page
    if (userID !== 'zitadel-cloud-login') {
      console.log('list-users action: ignoring request not coming from hosted login page');
      return res.json(resp);
    }

    const total = Number((resp.details && resp.details.totalResult) || 0);
    if (total > 0) {
      console.log('list-users action: user already found, skipping migration');
      return res.json(resp);
    }

    const q = (((body.request || {}).queries || [])[0] || {}).loginNameQuery;
    const loginName = q && q.loginName ? String(q.loginName) : null;

    // Check if user exists in legacy DB (replace with real calls later)
     // --->
    if (!loginName || !LEGACY_DB[loginName]) {
      console.log('No legacy user found for loginName:', loginName);
      return res.json(resp);
    }
    // <---

    // Create user in Zitadel from legacy data
    let userId = await createUserFromLegacy(LEGACY_DB[loginName]);

    // Retrieve newly created user for confirmation
    const userSearch = await zFetch(`/v2/users/${userId}`, { method: 'GET' });
    const userObj = userSearch.user || {};

    const manipulated = {
      details: {
        totalResult: "1",
        timestamp: new Date().toISOString()
      },
      result: [
        {
          userId: userObj.userId,
          details: userObj.details,
          state: userObj.state || "USER_STATE_ACTIVE",
          username: userObj.username,
          loginNames: userObj.loginNames || [loginName],
          preferredLoginName: userObj.preferredLoginName || loginName,
          human: userObj.human
        }
      ]
    };

    return res.json(manipulated);
  } catch (e) {
    console.error('list-users action error:', e);
    return res.status(200).json(req.body?.response || {});
  }
});

// --- Request Action (restWebhook): SetSession ---
app.post('/action/set-session', async (req, res) => {
  // Validate signature first
  const SETSESSION_SIGNING_KEY = process.env.SETSESSION_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, SETSESSION_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

  try {
    const { request, response } = req.body || {};
    const pw = request?.checks?.password?.password;
    const sessionId = request?.sessionId;
    const sessionToken = request?.sessionToken;

    // We only want to handle requests adding a password check
    if (!pw) return res.json(response || {});

    // Retrieve session details to get userId and loginName
    const search = await zFetch(`/v2/sessions/${sessionId}?sessionToken=${encodeURIComponent(sessionToken)}`, {
      method: 'GET'
    });
    const userId = search?.session?.factors?.user?.id;
    const legacyLoginName = search?.session?.factors?.user?.loginName;

    const { migrated, metadata } = await getUserMigrationMetadata(userId);

    // If user already migrated or no migration metadata, skip password set
    if (migrated) {
      console.info('User already migrated, skipping password set for user:', userId);
      return res.json(response || {});
    }
    if (metadata.length === 0) {
      console.info('No migration metadata found, skipping password set for user:', userId);
      return res.json(response || {});
    }

    // Verify user password in legacy DB
    const legacy = LEGACY_DB[legacyLoginName];
    if (pw !== legacy.password) {
      // Forward error through Zitadel if the password doesn't match - Interrupt on Error must be enabled
      return res.status(200).json({
          "forwardedStatusCode": 400,
          "forwardedErrorMessage": "Wrong username or password. Please try again."
      });
    }

    // Set user password in Zitadel and update metadata to mark migration complete
    if (userId) {
      await setUserPassword(userId, pw);
      await zFetch(`/v2/users/${userId}/metadata`, {
        method: 'POST',
        body: JSON.stringify({
          metadata: [{ key: "migratedFromLegacy", value: Buffer.from("true").toString("base64") }]
        })
      });
    }

    return res.json(response || {});
  } catch (e) {
    console.error('set-session action error:', e);
    return res.status(200).json(req.body?.response || {});
  }
});

// --- Response Action (restWebhook): SetPassword ---
app.post('/action/set-password', async (req, res) => {
  // Validate signature first
  const SETPASSWORD_SIGNING_KEY = process.env.SETPASSWORD_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, SETPASSWORD_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

  try {
    const { request, response } = req.body || {};
    const userId = request?.userId;

    if (!userId) {
      console.error('Missing userId in SetPassword request');
      return res.status(400).json({ error: 'Missing userId in request' });
    }

    const { migrated, metadata } = await getUserMigrationMetadata(userId);

    // If user already migrated or no migration metadata, skip password set
    if (migrated) {
      console.info('User already migrated, skipping password set for user:', userId);
      return res.json(response || {});
    }
    if (metadata.length === 0) {
      console.info('No migration metadata found, skipping password set for user:', userId);
      return res.json(response || {});
    }

    // If SetPassword response is successful, update metadata flag
    console.info('SetPassword action successful, updating metadata for user:', userId);
    await zFetch(`/v2/users/${userId}/metadata`, {
      method: 'POST',
      body: JSON.stringify({
        metadata: [{ key: "migratedFromLegacy", value: Buffer.from("true").toString("base64") }]
      })
    });

    return res.json(response || {});
  } catch (e) {
    console.error('SetPassword action error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
