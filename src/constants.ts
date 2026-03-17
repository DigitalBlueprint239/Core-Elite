export interface Drill {
  id: string;
  label: string;
  type: 'numeric' | 'rubric' | 'quiz';
  unit: string;
  recommended_range?: { min: number; max: number };
  attempts_allowed: number;
  use_best_attempt: boolean;
}

export const DRILL_CATALOG: Drill[] = [
  { id: 'forty', label: '40-Yard Dash', type: 'numeric', unit: 'sec', recommended_range: { min: 4.0, max: 7.0 }, attempts_allowed: 2, use_best_attempt: true },
  { id: 'ten_split', label: '10-Yard Split', type: 'numeric', unit: 'sec', recommended_range: { min: 1.4, max: 2.5 }, attempts_allowed: 2, use_best_attempt: true },
  { id: 'shuttle_5_10_5', label: '5-10-5 Shuttle', type: 'numeric', unit: 'sec', recommended_range: { min: 4.0, max: 6.0 }, attempts_allowed: 2, use_best_attempt: true },
  { id: 'three_cone', label: '3-Cone Drill', type: 'numeric', unit: 'sec', recommended_range: { min: 6.5, max: 9.0 }, attempts_allowed: 2, use_best_attempt: true },
  { id: 'vertical', label: 'Vertical Jump', type: 'numeric', unit: 'inches', recommended_range: { min: 10, max: 50 }, attempts_allowed: 2, use_best_attempt: true },
  { id: 'broad', label: 'Broad Jump', type: 'numeric', unit: 'inches', recommended_range: { min: 60, max: 144 }, attempts_allowed: 2, use_best_attempt: true },
  { id: 'bench_reps', label: 'Bench Press Reps', type: 'numeric', unit: 'reps', recommended_range: { min: 0, max: 50 }, attempts_allowed: 1, use_best_attempt: true },
  { id: 'position_score', label: 'Position Score', type: 'rubric', unit: 'points', recommended_range: { min: 1, max: 10 }, attempts_allowed: 1, use_best_attempt: true },
  { id: 'football_iq', label: 'Football IQ', type: 'quiz', unit: 'points', recommended_range: { min: 0, max: 100 }, attempts_allowed: 1, use_best_attempt: true },
];
