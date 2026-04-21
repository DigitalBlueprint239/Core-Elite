export const PLANS = {
  combine_registration: {
    key: 'combine_registration' as const,
    name: 'Live Combine Registration',
    price: 49,
    interval: 'one_time' as const,
    priceId: import.meta.env.VITE_STRIPE_PRICE_COMBINE ?? '',
    paymentLink: import.meta.env.VITE_STRIPE_LINK_COMBINE ?? '',
  },
  athlete_pro: {
    key: 'athlete_pro' as const,
    name: 'Athlete Pro',
    price: 14.99,
    interval: 'month' as const,
    priceId: import.meta.env.VITE_STRIPE_PRICE_ATHLETE_PRO ?? '',
    paymentLink: import.meta.env.VITE_STRIPE_LINK_ATHLETE_PRO ?? '',
  },
  enterprise: {
    key: 'enterprise' as const,
    name: 'Enterprise',
    price: 36000,
    interval: 'year' as const,
    priceId: import.meta.env.VITE_STRIPE_PRICE_ENTERPRISE ?? '',
    paymentLink: import.meta.env.VITE_STRIPE_LINK_ENTERPRISE ?? '',
  },
} as const;

export type PlanKey = keyof typeof PLANS;
export type ActivePlan = 'athlete_pro' | 'enterprise' | null;

export function redirectToCheckout(planKey: PlanKey): void {
  const link = PLANS[planKey].paymentLink;
  if (link) {
    window.location.href = link;
  }
}
