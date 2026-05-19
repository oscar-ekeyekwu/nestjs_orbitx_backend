/**
 * Shared payment-method enum used by Transaction and Order entities.
 * Extracted into its own module so the entity files don't form a
 * circular import (order ↔ transaction) when one references the other.
 */
export enum PaymentMethod {
  CASH = 'cash',
  CARD = 'card',
  BANK_TRANSFER = 'bank_transfer',
  WALLET = 'wallet',
}
