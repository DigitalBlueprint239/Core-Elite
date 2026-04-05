import { z } from 'zod';

// Zod Schemas for Validation
export const athleteRegistrationSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(50),
  lastName: z.string().min(1, 'Last name is required').max(50),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format'),
  grade: z.string().min(1, 'Grade is required'),
  position: z.string().min(1, 'Position is required'),
  parentName: z.string().min(1, 'Parent name is required').max(100),
  parentEmail: z.string().email('Invalid email address'),
  parentPhone: z.string().min(10, 'Invalid phone number'),
  guardianRelationship: z.string().min(1, 'Relationship is required'),
  emergencyContactName: z.string().min(1, 'Emergency contact is required'),
  emergencyContactPhone: z.string().min(10, 'Invalid phone number'),
  injuryWaiverAck: z.boolean().refine(v => v === true, 'Waiver must be accepted'),
  mediaRelease: z.boolean(),
  dataConsent: z.boolean().refine(v => v === true, 'Consent is required'),
  marketingConsent: z.boolean()
});

export const resultSubmissionSchema = z.object({
  athlete_id: z.string().uuid(),
  band_id: z.string().min(1),
  drill_type: z.string().min(1),
  value_num: z.number().positive(),
  meta: z.record(z.string(), z.any()).optional()
});

// Database Types (Simplified for now, in a real app these would be generated)
export interface Athlete {
  id: string;
  event_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  grade: string;
  position: string;
  parent_name: string;
  parent_email: string;
  parent_phone: string;
  band_id?: string;
  created_at: string;
  bands?: {
    display_number: string;
  };
  results?: Result[];
}

export interface Result {
  id: string;
  client_result_id: string;
  athlete_id: string;
  band_id: string;
  station_id: string;
  drill_type: string;
  value_num: number;
  recorded_at: string;
  // Phase 2: hlc_timestamp is now a first-class column (v2 §3.1.3, v3 §3.1.2).
  // Format: "{pt:016d}_{l:010d}_{nodeId}" — lexicographically sortable B-Tree index.
  hlc_timestamp?: string;
  // Phase 2: each rep is a separate immutable record (v1 §3.6.4).
  // Monotonically increasing per (athlete_id, event_id, drill_type).
  // Best result computed at query time — never merged or deduplicated.
  attempt_number: number;
  // Phase 2: tracks 4-gate validation outcome (idx_results_pending_validation, v2 §3.3.3).
  // 'extraordinary' rows are pending admin review after scout confirmation.
  validation_status: 'clean' | 'extraordinary' | 'reviewed';
  meta?: any;
}

export interface Station {
  id: string;
  event_id: string;
  name: string;
  type: string;
  drill_type: string;
  status?: DeviceStatus;
}

export interface DeviceStatus {
  station_id: string;
  device_label: string;
  last_seen_at: string;
  is_online: boolean;
  pending_queue_count: number;
  last_sync_at?: string;
}

export interface Event {
  id: string;
  name: string;
  slug: string;
  status: 'draft' | 'live' | 'completed';
  location: string;
  required_drills: string[];
  created_at: string;
}
