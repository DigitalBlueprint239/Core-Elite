import { useEffect } from 'react';
import { useOrganization } from '../hooks/useOrganization';

interface ThemeProviderProps {
  children: React.ReactNode;
  /** Pass eventId for public pages so the org can be inferred from the event */
  eventId?: string;
}

/**
 * Injects CSS custom properties based on the active organization's brand colors.
 * Authenticated pages resolve the org via the user's profile.
 * Public pages pass eventId to infer the org from events.organization_id.
 * Falls back to Core Elite defaults (#18181b primary, #c8a200 accent) if unresolved.
 */
export function ThemeProvider({ children, eventId }: ThemeProviderProps) {
  const { org } = useOrganization(eventId);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', org.primary_color);
    root.style.setProperty('--brand-accent', org.secondary_color);
  }, [org.primary_color, org.secondary_color]);

  return <>{children}</>;
}
