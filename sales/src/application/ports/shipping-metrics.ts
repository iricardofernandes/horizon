/**
 * The order-to-shipment service level (Phase 70): seconds from an order's confirmation to
 * each shipment that leaves. No label names a tenant, order or customer (ADR 0055).
 */
export interface ShippingMetrics {
  shipped(secondsSinceConfirmation: number): void
}

export const NO_SHIPPING_METRICS: ShippingMetrics = { shipped: () => undefined }
