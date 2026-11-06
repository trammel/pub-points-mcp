# How it works

The Pass runs on EonX's loyalty platform. This server calls three services.

## Sign-in: AWS Cognito

- User pool `ap-southeast-2_yLZxf0JXk`, with The Pass's public client ID and no client secret.
- `login` uses SRP, so the password never leaves the machine as plain text. After that the server uses REFRESH_TOKEN_AUTH to get fresh ID tokens.
- `logout` calls RevokeToken before deleting the session file.

## Data: The Pass API

`https://api.prod.v1.avc.eonx.com`, with the Cognito ID token as the bearer token.

- Version check: `POST /public/mobile-app-update-check`.
- Reads: `/customer-balances`, `/customers/me`, `/customers/me/tier`, `/customers/me/referral-code`, `/customers/me/birthday-gift`, `/customer-organisations`, `/customer-organisations/{id}`, `/orders`, `/orders/{id}`, `/favourite-venues`, `/tiers`, `/points-exchange-rates`, `/credits`, `/activities`, `/communication-preferences`, `/available-tiles`, `/available-offers/{id}`, `/public/settings`, and `POST /available-offers/search` and `POST /code-info`.
- Writes: `/in-app-offer-customer-activations`, `/instant-reward-offer-redemptions`, `/code-offer-customer-activations`, `/points-redemptions`, `/promo-code-redemptions`, `/gift-voucher-redemptions`, `/customer-organisations`, `/customer-referral-code-redemptions`, `/customers/me/birthday-gift/redemptions`, `/communication-preferences` and `/favourite-venues` (POST and DELETE).

## Venues: Algolia

Venue search and lookup, with a short-lived key from `POST /algolia-api-keys`. A key that is rejected is fetched again once.

## Requests and responses

- Every request times out after 15 seconds, and cancelling a tool call in the MCP client cancels its requests.
- Every response is checked against the shape the tools expect. A mismatch is reported with the endpoint and field, never by showing the raw response.

## Data quirks

- Credit, reward, order and spend amounts come back in cents.
- Percentage discounts come back as whole numbers.
- An order's `subtotal` excludes GST; receipts use the amount with tax.
- Venue opening-hour slots are keyed by UTC weekday and UTC time. The display text is in the venue's local time.
- `/code-info` labels any code it doesn't recognise as `gift_voucher`.
