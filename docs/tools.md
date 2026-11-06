# Tools

The server offers 29 tools: 21 that only read, and 8 that change your account. In [read-only mode](configuration.md#read-only-mode) only the 21 read tools are offered.

You don't call these yourself. Ask your assistant a question and it picks the tool.

## Points, discounts and history

| Tool | What it returns |
|---|---|
| `pub_points_summary` | Points balance, credit balance, points expiry, tier, spend to next tier, next points reward |
| `pub_points_discounts` | Everything that lowers your bill: tier benefits, group (organisation) discounts and their offers, offers waiting to be activated, activated offers, birthday gift, available credit, rewards you can redeem now |
| `pub_points_rewards` | Points-to-credit rewards, each marked "can redeem now" or "N points short" |
| `pub_points_credits` | Unspent credit, soonest expiry first |
| `pub_points_activity` | Account history: orders, redemptions, promo codes, tier changes, expiries. Filter by type, date or venue. Reads at most the newest 2,000 records, and says so when that cuts a range short |
| `pub_points_spending` | Total spent, points earned, top venues and a month-by-month breakdown, from every completed order in the date range |
| `pub_points_orders` | Orders paid through The Pass, newest first, filtered by date, status (`completed`, `reversed`, `all`) or venue |
| `pub_points_order_details` | Itemised receipt for one order: items, discounts (offer or group), surcharges, total with GST, payment method |
| `pub_points_group_discounts` | Each group you belong to, its discount, and the venues it applies at, with open-now status |
| `pub_points_favourite_venues` | Your favourite venues, with open-now status |
| `pub_points_tiers` | Every tier and its benefits, marking yours |
| `pub_points_referral` | Your refer-a-friend code, what it earns, and the program rules |
| `pub_points_promotions` | Promotions on the app's home screen |
| `pub_points_profile` | Name, email, mobile, date of birth, member since, preferred card (last four digits only) |
| `pub_points_communication_preferences` | Which push, email and SMS messages you receive |

Profile details (name, email, mobile) are read-only here. The app changes them in its login system and its API together, and this server only talks to the API.

## Offers and venues

| Tool | What it returns |
|---|---|
| `pub_points_offers` | Every offer, filtered by status (`all`, `activated`, `not_activated`) and optionally by title. `not_activated` shows what is still waiting for you to activate |
| `pub_points_offer_details` | One offer's description, terms, how it activates, and the venues it works at |
| `pub_points_find_venues` | Venues by name, suburb or location, with open-now status; optional opening hours, styles and links |
| `pub_points_venue_offers` | Offers at particular venues |
| `pub_points_check_code` | What kind of code something is, and which tool redeems it, without redeeming it |
| `pub_points_doctor` | Health check: is the client version still accepted, and does each endpoint still return the fields the tools use. See [troubleshooting](troubleshooting.md) |

Offers, orders, venue search and rewards also return `structuredContent` with an `outputSchema`, for clients that read data rather than text.

## Actions

Each of these checks the request against your account, then asks you before changing anything. How that works: [confirmations](confirmations.md).

| Tool | What it does |
|---|---|
| `pub_points_activate_offer` | Activates an in-app offer, or redeems an instant reward, as the app's offer button does. Offers that apply automatically are refused, since there is nothing to activate |
| `pub_points_redeem_points` | Exchanges points for credit. Refused if your balance is too low |
| `pub_points_redeem_code` | Redeems gift vouchers, promo codes, offer codes and a friend's referral code. Use `pub_points_join_organisation` for group codes |
| `pub_points_join_organisation` | **How to add a group discount.** Joins a workplace, club or association with the group code it gave you. It checks the code first and refuses anything that isn't a group code, so it can't use up a voucher or promo code by mistake |
| `pub_points_redeem_birthday_gift` | Claims your birthday credit when one is available |
| `pub_points_set_communication_preferences` | Turns push, email or SMS message types on or off |
| `pub_points_add_favourite_venue` | Adds a venue to favourites |
| `pub_points_remove_favourite_venue` | Removes a venue from favourites |

## Joining a group discount

Workplaces, sports clubs and associations can give members a group code that unlocks a discount at some or all venues. To join one, ask your assistant something like "join my work's group discount with code ABC123". It uses `pub_points_join_organisation`, which confirms the code is a group code, shows what it would do, and joins once you agree. `pub_points_group_discounts` lists your current groups and the venues each one covers.
