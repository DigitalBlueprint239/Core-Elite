import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Users, ClipboardCheck, BarChart3 } from 'lucide-react';
import { motion } from 'motion/react';
import { supabase } from '../lib/supabase';
import { BRAND } from '../lib/brand';

export default function Home() {
  const [activeEventSlug, setActiveEventSlug] = useState<string | null>(null);
  const [eventInfo, setEventInfo] = useState<{ name: string; location: string; date: string } | null>(null);

  useEffect(() => {
    async function fetchActiveEvent() {
      const { data: live } = await supabase
        .from('events')
        .select('slug, name, location, created_at')
        .eq('status', 'live')
        .limit(1)
        .maybeSingle();
      if (live) {
        setActiveEventSlug(live.slug);
        setEventInfo({
          name: live.name,
          location: live.location,
          date: new Date(live.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        });
      } else {
        const { data: draft } = await supabase
          .from('events')
          .select('slug, name, location, created_at')
          .eq('status', 'draft')
          .limit(1)
          .maybeSingle();
        if (draft) {
          setActiveEventSlug(draft.slug);
          setEventInfo({
            name: draft.name,
            location: draft.location,
            date: new Date(draft.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
          });
        }
      }
    }
    fetchActiveEvent();
  }, []);

  const registerLink = activeEventSlug ? `/register?event=${activeEventSlug}` : '/register';

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Hero */}
      <header className="bg-zinc-900 text-white px-6 pt-16 pb-20 relative overflow-hidden">
        <div className="absolute inset-0 opacity-5" style={{ backgroundImage: 'repeating-linear-gradient(45deg, #c8a200 0, #c8a200 1px, transparent 0, transparent 50%)', backgroundSize: '20px 20px' }} />
        <div className="max-w-4xl mx-auto relative text-center">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="inline-block mb-6"
          >
            <img src={BRAND.logo} alt="Core Elite" className="w-16 h-16 mx-auto" />
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-5xl md:text-6xl font-black uppercase italic tracking-tighter mb-3"
          >
            CORE ELITE <span style={{ color: '#c8a200' }}>COMBINE 2026</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-zinc-400 text-lg mb-3"
          >
            Where Data Meets Performance
          </motion.p>
          {eventInfo && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="text-zinc-500 text-sm"
            >
              {eventInfo.date} &bull; {eventInfo.location}
            </motion.p>
          )}
        </div>
      </header>

      {/* Cards */}
      <main className="max-w-4xl mx-auto px-4 -mt-10 pb-16 space-y-4">
        <Link to={registerLink}>
          <motion.div
            whileHover={{ y: -4 }}
            className="p-8 bg-white rounded-3xl border-l-4 border-l-[#c8a200] border border-zinc-200 shadow-sm hover:shadow-md transition-all group"
          >
            <Users className="w-10 h-10 text-zinc-900 mb-4 group-hover:scale-110 transition-transform" />
            <h2 className="text-2xl font-bold mb-1">Athlete Registration</h2>
            <p className="text-zinc-500">Lock in your spot. Show what you're made of.</p>
            <div className="mt-4">
              <Link
                to="/lookup"
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-zinc-400 hover:text-zinc-900 font-bold"
              >
                Already registered? Find your info →
              </Link>
            </div>
          </motion.div>
        </Link>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link to="/staff/login">
            <motion.div
              whileHover={{ y: -4 }}
              className="p-8 bg-white rounded-3xl border border-zinc-200 shadow-sm hover:shadow-md transition-all group"
            >
              <ClipboardCheck className="w-10 h-10 text-zinc-900 mb-4 group-hover:scale-110 transition-transform" />
              <h2 className="text-2xl font-bold mb-1">Staff Station</h2>
              <p className="text-zinc-500">Log in. Record results. Keep the event moving.</p>
            </motion.div>
          </Link>

          <Link to="/admin/login">
            <motion.div
              whileHover={{ y: -4 }}
              className="p-8 bg-zinc-900 text-white rounded-3xl shadow-xl hover:shadow-2xl transition-all group"
            >
              <BarChart3 className="w-10 h-10 mb-4 group-hover:scale-110 transition-transform" style={{ color: '#c8a200' }} />
              <h2 className="text-2xl font-bold mb-1">Admin Dashboard</h2>
              <p className="text-zinc-400">Live command center. Full visibility. Total control.</p>
            </motion.div>
          </Link>
        </div>
      </main>

      <footer className="pb-8 text-center text-zinc-400 text-sm flex items-center justify-center gap-2">
        <img src={BRAND.logo} alt="" className="w-4 h-4 opacity-50" />
        &copy; 2026 Core Elite Athletic Testing. All rights reserved.
      </footer>
    </div>
  );
}
