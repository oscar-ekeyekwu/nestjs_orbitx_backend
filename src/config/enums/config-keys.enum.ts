export enum ConfigKey {
  // Driver Settings
  DRIVER_MIN_BALANCE = 'DRIVER_MIN_BALANCE',
  DRIVER_COMMISSION_PERCENTAGE = 'DRIVER_COMMISSION_PERCENTAGE',

  // Order Settings
  ORDER_DELIVERY_RADIUS_KM = 'ORDER_DELIVERY_RADIUS_KM',
  ORDER_BASE_PRICE = 'ORDER_BASE_PRICE',
  ORDER_PRICE_PER_KM = 'ORDER_PRICE_PER_KM',

  // Package Size Multipliers
  PACKAGE_SIZE_SMALL_MULTIPLIER = 'PACKAGE_SIZE_SMALL_MULTIPLIER',
  PACKAGE_SIZE_MEDIUM_MULTIPLIER = 'PACKAGE_SIZE_MEDIUM_MULTIPLIER',
  PACKAGE_SIZE_LARGE_MULTIPLIER = 'PACKAGE_SIZE_LARGE_MULTIPLIER',

  // System Settings
  MAX_ORDERS_PER_DRIVER = 'MAX_ORDERS_PER_DRIVER',
  ORDER_AUTO_CANCEL_MINUTES = 'ORDER_AUTO_CANCEL_MINUTES',

  // Feature Flags
  USE_MAP_VIEW = 'USE_MAP_VIEW',

  // Service Zone (ARCH-5)
  LAGOS_SERVICE_BBOX = 'LAGOS_SERVICE_BBOX',

  // Vehicle edit policy (seeded in B7; consumed by F3 in Sprint 4).
  // Allowed values: 'continue' | 'pending'. 'continue' lets the vehicle
  // stay operational while an edit goes through approval; 'pending'
  // pulls it from dispatch until the admin signs off.
  VEHICLE_EDIT_GRACE_MODE = 'VEHICLE_EDIT_GRACE_MODE',

  // G3 — platform bank account customers transfer to when paying by
  // manual transfer. Stored as JSON `{ bankName, accountName,
  // accountNumber }` so the admin can update without a deploy.
  PLATFORM_BANK_ACCOUNT = 'PLATFORM_BANK_ACCOUNT',

  // G4 — minimum wallet balance (in Naira) a recipient must hit to be
  // included in the weekly payout cron. Below the threshold the row
  // is skipped — the balance rolls over to the next week.
  MIN_PAYOUT_THRESHOLD = 'MIN_PAYOUT_THRESHOLD',
}

export const DEFAULT_CONFIG_VALUES: Record<
  ConfigKey,
  {
    value: string;
    description: string;
    dataType: 'string' | 'number' | 'boolean' | 'json';
  }
> = {
  [ConfigKey.DRIVER_MIN_BALANCE]: {
    value: '5000',
    description:
      'Minimum balance (in Naira) required for drivers to accept orders',
    dataType: 'number',
  },
  [ConfigKey.DRIVER_COMMISSION_PERCENTAGE]: {
    value: '15',
    description:
      'Platform commission percentage taken from each completed order (G5). Stored on each transactions.commissionPct row at completion time so retroactive rate changes never rewrite historical splits.',
    dataType: 'number',
  },
  [ConfigKey.ORDER_DELIVERY_RADIUS_KM]: {
    value: '50',
    description: 'Maximum radius (in kilometers) for order delivery matching',
    dataType: 'number',
  },
  [ConfigKey.ORDER_BASE_PRICE]: {
    value: '1000',
    description: 'Base price (in Naira) for all deliveries',
    dataType: 'number',
  },
  [ConfigKey.ORDER_PRICE_PER_KM]: {
    value: '100',
    description: 'Price (in Naira) per kilometer for deliveries',
    dataType: 'number',
  },
  [ConfigKey.PACKAGE_SIZE_SMALL_MULTIPLIER]: {
    value: '1',
    description: 'Price multiplier for small packages',
    dataType: 'number',
  },
  [ConfigKey.PACKAGE_SIZE_MEDIUM_MULTIPLIER]: {
    value: '1.5',
    description: 'Price multiplier for medium packages',
    dataType: 'number',
  },
  [ConfigKey.PACKAGE_SIZE_LARGE_MULTIPLIER]: {
    value: '2',
    description: 'Price multiplier for large packages',
    dataType: 'number',
  },
  [ConfigKey.MAX_ORDERS_PER_DRIVER]: {
    value: '1',
    description: 'Maximum number of simultaneous orders a driver can handle',
    dataType: 'number',
  },
  [ConfigKey.ORDER_AUTO_CANCEL_MINUTES]: {
    value: '30',
    description:
      'Minutes before an unaccepted order is automatically cancelled',
    dataType: 'number',
  },
  [ConfigKey.USE_MAP_VIEW]: {
    value: 'true',
    description:
      'When true, customer order tracking screen renders the Google Map view. When false, renders the timeline-only fallback.',
    dataType: 'boolean',
  },
  [ConfigKey.LAGOS_SERVICE_BBOX]: {
    value: JSON.stringify({
      latMin: 6.35,
      latMax: 6.7,
      lngMin: 3.1,
      lngMax: 3.55,
    }),
    description:
      'Inclusive lat/lng bounding box for the Lagos service zone. Drivers cannot go online and orders cannot be created outside this region. Admin-tunable without redeploy; v1.1 swaps this for a PostGIS service_zones polygon at the same callsites.',
    dataType: 'json',
  },
  [ConfigKey.VEHICLE_EDIT_GRACE_MODE]: {
    value: 'continue',
    description:
      'How a vehicle behaves while an edit is awaiting admin review. "continue" = stays operational, "lock" = driver cannot accept orders (VEHICLE_002). Consumed by F2; F3 exposes the toggle in the admin console.',
    dataType: 'string',
  },
  [ConfigKey.PLATFORM_BANK_ACCOUNT]: {
    value: JSON.stringify({
      bankName: 'Pending — set in admin console',
      accountName: 'Orbit Technologies Ltd',
      accountNumber: '0000000000',
    }),
    description:
      'Static bank account customers transfer to when paying by manual bank transfer (G3). JSON shape: { bankName, accountName, accountNumber }. Admins update via the H8 transfers page.',
    dataType: 'json',
  },
  [ConfigKey.MIN_PAYOUT_THRESHOLD]: {
    value: '1000',
    description:
      'Minimum wallet balance (in Naira) a recipient must hit to be included in the weekly payout cron (G4). Balances below the threshold roll over.',
    dataType: 'number',
  },
};
