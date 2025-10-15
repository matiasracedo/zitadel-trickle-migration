# Trickle Migration API

This project provides an API for migrating legacy users to Zitadel using Actions. The API includes endpoints for handling user listing and session management, ensuring a smooth migration process.

## API Endpoints

### 1. `/action/list-users`
**Method:** POST

This endpoint is triggered when the Zitadel hosted login page checks if a user exists. It captures the response from the Zitadel `/zitadel.user.v2.UserService/ListUsers` endpoint and performs the following:

- Validates the webhook signature using the `LISTUSERS_SIGNING_KEY`.
- Checks if the user exists in Zitadel first, and if not, in the legacy database.
- If the user exists in the legacy database but not in Zitadel, it creates the user in Zitadel using the legacy data.
- Modifies the response to include the newly created user profile in flight.

### 2. `/action/set-session`
**Method:** POST

This endpoint is triggered when the Zitadel hosted login page attempts to set verify the user password and add the additional session check. It captures the request to the Zitadel `/zitadel.session.v2.SessionService/SetSession` endpoint and performs the following:

- Validates the webhook signature using the `SETSESSION_SIGNING_KEY`.
- Verifies the user’s password against the legacy database.
- If the password matches, updates the user’s password in Zitadel and marks the migration as complete.

## Environment Variables

Ensure the following environment variables are set in your `.env` file:

- `ZITADEL_DOMAIN`: The Zitadel domain (e.g., `auth.example.com`).
- `ACCESS_TOKEN`: The access token for Zitadel APIs. It can be a PAT from a Service User with at least `ORG_OWNER` and `IAM_LOGIN_CLIENT` Manager Roles.
- `ZITADEL_ORG_ID`: The organization ID in Zitadel where migrated users will be created.
- `LISTUSERS_SIGNING_KEY`: The signing key for the `/action/list-users` endpoint.
- `SETSESSION_SIGNING_KEY`: The signing key for the `/action/set-session` endpoint.

The signing keys are used for validating the webhook signature. Refer to [this guide](https://help.zitadel.com/how-to-validate-zitadel-actions-v2-signature-with-node.js) for details on generating and validating signing keys.

## Legacy Database

The legacy database is mocked in this project. Replace the `LEGACY_DB` object in `server.js` with actual calls to your legacy database.

## Running the Server

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   node server.js
   ```

3. The server will run on `http://localhost:5001`. You can follow [this guide](https://zitadel.com/docs/guides/integrate/actions/webhook-site-setup) for testing Actions locally using Webhook.site.

## Notes

- Ensure that the environment variables are correctly set before running the server.
- The API assumes that the legacy database contains user details in the format specified in the `LEGACY_DB` object in `server.js`.
- For signature validation, refer to the Zitadel [how-to guide](https://help.zitadel.com/how-to-validate-zitadel-actions-v2-signature-with-node.js).