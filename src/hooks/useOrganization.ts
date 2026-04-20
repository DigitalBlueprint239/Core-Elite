import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  contact_email: string | null;
}

const DEFAULT_ORG: Organization = {
  id: '',
  name: 'Core Elite Network',
  slug: 'core-elite',
  logo_url: null,
  primary_color: '#18181b',
  secondary_color: '#c8a200',
  contact_email: null,
};

/**
 * Resolves the active organization.
 *
 * Authenticated pages: fetch via profiles.organization_id for the current user.
 * Public pages: pass eventId to infer org from events.organization_id.
 * Falls back to Core Elite defaults if no org is found.
 */
export function useOrganization(eventId?: string): {
  org: Organization;
  loading: boolean;
} {
  const [org, setOrg] = useState<Organization>(DEFAULT_ORG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      setLoading(true);

      try {
        // 1. Try authenticated user's org first
        const { data: { user } } = await supabase.auth.getUser();

        if (user) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('organization_id')
            .eq('user_id', user.id)
            .single();

          if (profile?.organization_id) {
            const { data: orgData } = await supabase
              .from('organizations')
              .select('*')
              .eq('id', profile.organization_id)
              .single();

            if (orgData && !cancelled) {
              setOrg(orgData);
              setLoading(false);
              return;
            }
          }
        }

        // 2. For public pages — infer from event's organization_id
        if (eventId) {
          const { data: event } = await supabase
            .from('events')
            .select('organization_id')
            .eq('id', eventId)
            .maybeSingle();

          if (event?.organization_id) {
            const { data: orgData } = await supabase
              .from('organizations')
              .select('*')
              .eq('id', event.organization_id)
              .single();

            if (orgData && !cancelled) {
              setOrg(orgData);
              setLoading(false);
              return;
            }
          }
        }

        // 3. Fall back to Core Elite defaults
        if (!cancelled) {
          setOrg(DEFAULT_ORG);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setOrg(DEFAULT_ORG);
          setLoading(false);
        }
      }
    }

    resolve();
    return () => { cancelled = true; };
  }, [eventId]);

  return { org, loading };
}
