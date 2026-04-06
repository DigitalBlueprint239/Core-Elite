import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { motion } from 'motion/react';
import {
  Trophy,
  Activity,
  CheckCircle2,
  Clock,
  Download,
  ChevronRight,
  User,
  MapPin,
  Calendar,
  ArrowLeft
} from 'lucide-react';
import { SkeletonHeader, SkeletonResultCard } from '../components/Skeleton';

export default function ParentPortal() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPortalData() {
      setLoading(true);
      
      // 1. Get athlete_id from token
      const { data: portal, error: portalError } = await supabase
        .from('parent_portals')
        .select('athlete_id, event_id')
        .eq('portal_token', token)
        .single();

      if (portalError || !portal) {
        setError('Invalid or expired portal link.');
        setLoading(false);
        return;
      }

      // 2. Get athlete, event, results, and report job
      const [athleteRes, eventRes, resultsRes, reportRes] = await Promise.all([
        supabase.from('athletes').select('*').eq('id', portal.athlete_id).single(),
        supabase.from('events').select('*').eq('id', portal.event_id).single(),
        supabase.from('results').select('*').eq('athlete_id', portal.athlete_id),
        supabase.from('report_jobs').select('*').eq('athlete_id', portal.athlete_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
      ]);

      if (athleteRes.data && eventRes.data) {
        setData({
          athlete: athleteRes.data,
          event: eventRes.data,
          results: resultsRes.data || [],
          report: reportRes.data
        });
      } else {
        setError('Could not load athlete data.');
      }
      
      setLoading(false);
    }

    fetchPortalData();
  }, [token]);

  if (loading) return (
    <div className="min-h-screen bg-zinc-50 pb-12">
      <div className="bg-zinc-900 pt-12 pb-24 px-6">
        <div className="max-w-2xl mx-auto space-y-4 animate-pulse">
          <div className="h-16 w-16 bg-white/10 rounded-2xl" />
          <div className="h-6 bg-white/10 rounded w-2/5" />
          <div className="h-4 bg-white/10 rounded w-1/3" />
        </div>
      </div>
      <div className="max-w-2xl mx-auto px-6 -mt-12 space-y-6">
        <div className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-xl animate-pulse">
          <div className="h-12 bg-zinc-100 rounded-2xl w-full" />
        </div>
        <SkeletonHeader />
        <div className="space-y-3">
          <SkeletonResultCard />
          <SkeletonResultCard />
          <SkeletonResultCard />
        </div>
      </div>
    </div>
  );

  if (error || !data) return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-4">
      <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center max-w-sm">
        <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
          <Clock className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold mb-2">Access Denied</h2>
        <p className="text-zinc-500 text-sm">{error}</p>
      </div>
    </div>
  );

  const requiredCount = data.event.required_drills?.length || 5;
  const completedCount = data.results.length;
  const progress = Math.min((completedCount / requiredCount) * 100, 100);

  return (
    <div className="min-h-screen bg-zinc-50 pb-12">
      <div className="absolute top-4 left-4 z-20">
        <Link 
          to="/" 
          className="flex items-center gap-2 text-white/60 hover:text-white transition-colors text-xs font-bold uppercase tracking-wider"
        >
          <ArrowLeft className="w-4 h-4" />
          Home
        </Link>
      </div>
      <header className="bg-zinc-900 text-white pt-12 pb-24 px-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
        <div className="max-w-2xl mx-auto relative">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center text-3xl font-black italic">
              {data.athlete.band_id?.slice(-3) || '--'}
            </div>
            <div>
              <h1 className="text-2xl font-black uppercase italic tracking-tighter">{data.athlete.first_name} {data.athlete.last_name}</h1>
              <div className="flex items-center gap-3 text-zinc-400 text-xs font-bold uppercase tracking-wider">
                <span className="flex items-center gap-1"><User className="w-3 h-3" /> {data.athlete.position || 'Athlete'}</span>
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {data.event.location}</span>
              </div>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <div className="flex justify-between items-end mb-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Combine Progress</span>
              <span className="text-sm font-black">{completedCount}/{requiredCount} Drills</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                className="h-full bg-emerald-500"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 -mt-12 space-y-6">
        {/* Report Status */}
        <section className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-xl flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
              data.report?.status === 'ready' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
            }`}>
              {data.report?.status === 'ready' ? <CheckCircle2 className="w-6 h-6" /> : <Clock className="w-6 h-6" />}
            </div>
            <div>
              <h3 className="font-bold">Performance Report</h3>
              <p className="text-xs text-zinc-500">
                {data.report?.status === 'ready' ? 'Your elite report is ready for download.' : 'Generating report after all drills complete.'}
              </p>
            </div>
          </div>
          {data.report?.status === 'ready' ? (
            <button
              onClick={() => {
                if (data.report?.report_url) {
                  window.open(data.report.report_url, '_blank');
                } else {
                  alert('Report URL not available yet. Please try again shortly.');
                }
              }}
              className="p-3 bg-zinc-900 text-white rounded-xl shadow-lg hover:bg-zinc-800 transition-colors"
            >
              <Download className="w-5 h-5" />
            </button>
          ) : (
            <div className="px-3 py-1 bg-amber-50 text-amber-700 rounded-full text-[10px] font-black uppercase tracking-widest">
              {data.report?.status || 'Pending'}
            </div>
          )}
        </section>

        {/* Results List */}
        <section className="space-y-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Activity className="w-5 h-5 text-zinc-400" />
            Drill Results
          </h2>
          <div className="grid gap-3">
            {data.results.length === 0 ? (
              <div className="p-8 bg-white rounded-3xl border border-zinc-200 text-center text-zinc-400 text-sm italic">
                No results recorded yet.
              </div>
            ) : (
              data.results.map((res: any) => (
                <div key={res.id} className="bg-white p-4 rounded-2xl border border-zinc-200 shadow-sm flex items-center justify-between">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">{res.drill_type}</div>
                    <div className="text-lg font-black">{res.value_num} <span className="text-xs font-normal text-zinc-400">sec</span></div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-bold text-zinc-400 uppercase">{new Date(res.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <footer className="pt-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-100 rounded-full text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            <Trophy className="w-3 h-3" /> Core Elite Combine 2026
          </div>
        </footer>
      </main>
    </div>
  );
}
