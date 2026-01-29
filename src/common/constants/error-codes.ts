export const ErrorCodes = {
  // Authentication errors (AUTH_xxx)
  AUTH_001: 'INVALID_CREDENTIALS',
  AUTH_002: 'UNAUTHORIZED',
  AUTH_003: 'TOKEN_EXPIRED',
  AUTH_004: 'INVALID_TOKEN',
  AUTH_005: 'REFRESH_TOKEN_EXPIRED',
  AUTH_006: 'REFRESH_TOKEN_REVOKED',
  AUTH_007: 'USER_NOT_FOUND',
  AUTH_008: 'USER_INACTIVE',
  AUTH_009: 'EMAIL_ALREADY_EXISTS',
  AUTH_010: 'WEAK_PASSWORD',
  AUTH_011: 'INVALID_VERIFICATION_CODE',
  AUTH_012: 'VERIFICATION_CODE_EXPIRED',
  AUTH_013: 'MAX_VERIFICATION_ATTEMPTS_EXCEEDED',
  AUTH_014: 'EMAIL_NOT_VERIFIED',
  AUTH_015: 'PHONE_NOT_VERIFIED',

  // User errors (USER_xxx)
  USER_001: 'USER_NOT_FOUND',
  USER_002: 'USER_ALREADY_EXISTS',
  USER_003: 'USER_INACTIVE',
  USER_004: 'INSUFFICIENT_PERMISSIONS',
  USER_005: 'EMAIL_NOT_VERIFIED',
  USER_006: 'PHONE_NOT_VERIFIED',

  // Order errors (ORDER_xxx)
  ORDER_001: 'ORDER_NOT_FOUND',
  ORDER_002: 'ORDER_NOT_AVAILABLE',
  ORDER_003: 'INVALID_STATUS_TRANSITION',
  ORDER_004: 'ORDER_ALREADY_ACCEPTED',
  ORDER_005: 'ORDER_ALREADY_DELIVERED',
  ORDER_006: 'ORDER_ALREADY_CANCELLED',
  ORDER_007: 'CANNOT_CANCEL_DELIVERED_ORDER',
  ORDER_008: 'UNAUTHORIZED_ORDER_ACCESS',

  // Wallet errors (WALLET_xxx)
  WALLET_001: 'WALLET_NOT_FOUND',
  WALLET_002: 'INSUFFICIENT_BALANCE',
  WALLET_003: 'WALLET_LOCKED',
  WALLET_004: 'TRANSACTION_FAILED',
  WALLET_005: 'INVALID_AMOUNT',
  WALLET_006: 'MINIMUM_BALANCE_REQUIRED',

  // Driver errors (DRIVER_xxx)
  DRIVER_001: 'DRIVER_NOT_FOUND',
  DRIVER_002: 'DRIVER_NOT_VERIFIED',
  DRIVER_003: 'DRIVER_OFFLINE',
  DRIVER_004: 'DRIVER_NOT_AVAILABLE',
  DRIVER_005: 'INSUFFICIENT_DRIVER_BALANCE',

  // File upload errors (FILE_xxx)
  FILE_001: 'FILE_TOO_LARGE',
  FILE_002: 'INVALID_FILE_TYPE',
  FILE_003: 'UPLOAD_FAILED',
  FILE_004: 'FILE_NOT_FOUND',

  // Validation errors (VAL_xxx)
  VAL_001: 'VALIDATION_FAILED',
  VAL_002: 'INVALID_INPUT',
  VAL_003: 'MISSING_REQUIRED_FIELD',
  VAL_004: 'INVALID_EMAIL_FORMAT',
  VAL_005: 'INVALID_PHONE_FORMAT',
  VAL_006: 'INVALID_COORDINATES',

  // System errors (SYS_xxx)
  SYS_001: 'INTERNAL_SERVER_ERROR',
  SYS_002: 'DATABASE_ERROR',
  SYS_003: 'SERVICE_UNAVAILABLE',
  SYS_004: 'RATE_LIMIT_EXCEEDED',
  SYS_005: 'CONFIGURATION_ERROR',

  // Notification errors (NOTIF_xxx)
  NOTIF_001: 'NOTIFICATION_SEND_FAILED',
  NOTIF_002: 'INVALID_NOTIFICATION_TYPE',
  NOTIF_003: 'PUSH_TOKEN_INVALID',
  NOTIF_004: 'EMAIL_SEND_FAILED',
  NOTIF_005: 'SMS_SEND_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const getErrorCodeByMessage = (message: string): ErrorCode | null => {
  // Map common error messages to error codes
  const errorMessageMap: Record<string, ErrorCode> = {
    'Invalid credentials': ErrorCodes.AUTH_001,
    'Unauthorized': ErrorCodes.AUTH_002,
    'User not found': ErrorCodes.AUTH_007,
    'Email already exists': ErrorCodes.AUTH_009,
    'Wallet not found': ErrorCodes.WALLET_001,
    'Insufficient balance': ErrorCodes.WALLET_002,
    'Wallet is locked': ErrorCodes.WALLET_003,
    'Order not found': ErrorCodes.ORDER_001,
    'Order is not available': ErrorCodes.ORDER_002,
    'Not authorized to update this order': ErrorCodes.ORDER_008,
    'Cannot cancel delivered order': ErrorCodes.ORDER_007,
    'Driver not found': ErrorCodes.DRIVER_001,
    'Invalid refresh token': ErrorCodes.AUTH_004,
    'Refresh token has been revoked': ErrorCodes.AUTH_006,
    'Refresh token has expired': ErrorCodes.AUTH_005,
    'User account is inactive': ErrorCodes.AUTH_008,
  };

  // Check for partial matches
  for (const [key, value] of Object.entries(errorMessageMap)) {
    if (message.includes(key)) {
      return value;
    }
  }

  return null;
};
