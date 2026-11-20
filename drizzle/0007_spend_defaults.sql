-- Spend defaults (spec §12.5, §12.7, research §2.4), seeded once. Admins can change them afterwards.
-- The categories, in their default order. The two special ones can't be deleted or archived.
INSERT INTO `categories` (`name`, `kind`, `sort_order`, `archived`, `created_at`, `updated_at`) VALUES
  ('Groceries', 'normal', 1, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Dining', 'normal', 2, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Gas and auto', 'normal', 3, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Shopping', 'normal', 4, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Home', 'normal', 5, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Utilities', 'normal', 6, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Subscriptions', 'normal', 7, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Entertainment', 'normal', 8, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Travel', 'normal', 9, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Health', 'normal', 10, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Kids', 'normal', 11, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Gifts and donations', 'normal', 12, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Fees and interest', 'normal', 13, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Other', 'normal', 14, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Payments and transfers', 'excluded', 15, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000),
  ('Uncategorized', 'uncategorized', 16, 0, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000);
--> statement-breakpoint
-- Plaid PFCv2 codes to those categories: the 18 primaries, then the detailed codes whose answer
-- differs from their primary's (research §2.4). GENERAL_MERCHANDISE_SUPERSTORES is listed even
-- though it matches its primary, so nobody "fixes" it into Groceries.
WITH `m` (`code`, `category`) AS (VALUES
  ('FOOD_AND_DRINK', 'Dining'),
  ('GENERAL_MERCHANDISE', 'Shopping'),
  ('HOME_IMPROVEMENT', 'Home'),
  ('RENT_AND_UTILITIES', 'Utilities'),
  ('ENTERTAINMENT', 'Entertainment'),
  ('TRAVEL', 'Travel'),
  ('MEDICAL', 'Health'),
  ('TRANSPORTATION', 'Gas and auto'),
  ('BANK_FEES', 'Fees and interest'),
  ('PERSONAL_CARE', 'Other'),
  ('GENERAL_SERVICES', 'Other'),
  ('GOVERNMENT_AND_NON_PROFIT', 'Other'),
  ('LOAN_PAYMENTS', 'Payments and transfers'),
  ('TRANSFER_IN', 'Payments and transfers'),
  ('TRANSFER_OUT', 'Payments and transfers'),
  ('LOAN_DISBURSEMENTS', 'Payments and transfers'),
  ('INCOME', 'Payments and transfers'),
  ('OTHER', 'Uncategorized'),
  ('FOOD_AND_DRINK_GROCERIES', 'Groceries'),
  ('FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR', 'Groceries'),
  ('GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES', 'Gifts and donations'),
  ('GENERAL_MERCHANDISE_SUPERSTORES', 'Shopping'),
  ('RENT_AND_UTILITIES_RENT', 'Home'),
  ('GENERAL_SERVICES_AUTOMOTIVE', 'Gas and auto'),
  ('GENERAL_SERVICES_CHILDCARE', 'Kids'),
  ('GENERAL_SERVICES_EDUCATION', 'Kids'),
  ('GENERAL_SERVICES_INSURANCE', 'Other'),
  ('GOVERNMENT_AND_NON_PROFIT_DONATIONS', 'Gifts and donations'),
  ('PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', 'Health'),
  ('MEDICAL_VETERINARY_SERVICES', 'Other'),
  ('TRANSPORTATION_PUBLIC_TRANSIT', 'Travel'),
  ('TRANSPORTATION_TAXIS_AND_RIDE_SHARES', 'Travel'),
  ('TRANSPORTATION_BIKES_AND_SCOOTERS', 'Travel'))
INSERT INTO `category_mappings` (`plaid_pfc`, `taxonomy_version`, `category_id`, `updated_at`)
SELECT `m`.`code`, 'v2', `categories`.`id`, cast(strftime('%s', 'now') as integer) * 1000
FROM `m` JOIN `categories` ON `categories`.`name` = `m`.`category`;
--> statement-breakpoint
-- A card payment is a credit whose payee says PAYMENT (BofA's exact wording is unverified, research
-- §1.2 and "CSV importer" step 8). CSV rows have no Plaid category, so without this rule every
-- payment would count as a refund against the cycle's spend. Admins can edit or delete it.
INSERT INTO `rules` (`position`, `match_text`, `match_type`, `max_cents`, `set_category_id`, `created_at`, `updated_at`)
SELECT 1, 'PAYMENT', 'contains', -1, `id`, cast(strftime('%s', 'now') as integer) * 1000, cast(strftime('%s', 'now') as integer) * 1000
FROM `categories` WHERE `kind` = 'excluded';
