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
}

export const DEFAULT_CONFIG_VALUES: Record<
  ConfigKey,
  { value: string; description: string; dataType: 'string' | 'number' | 'boolean' | 'json' }
> = {
  [ConfigKey.DRIVER_MIN_BALANCE]: {
    value: '5000',
    description: 'Minimum balance (in Naira) required for drivers to accept orders',
    dataType: 'number',
  },
  [ConfigKey.DRIVER_COMMISSION_PERCENTAGE]: {
    value: '20',
    description: 'Platform commission percentage taken from each delivery',
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
    description: 'Minutes before an unaccepted order is automatically cancelled',
    dataType: 'number',
  },
};
