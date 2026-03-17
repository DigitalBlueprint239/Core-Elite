import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Trophy, Users, ClipboardCheck, BarChart3 } from 'lucide-react';
import { motion } from 'motion/react';
import { supabase } from '../lib/supabase';

export default function Home() {
  const [activeEventSlug, setActiveEventSlug] = useState<string | null>(null);

  useEffect(() => {
    async function fetchActiveEvent() {
      // Try to find a 'live' event first, then any 'draft' event
      const { data } = await supabase
        .from('events')
        .select('slug')
        .order('status', { ascending: false }) // 'live' > 'draft' alphabetically if we are lucky, but let's be explicit
        .order('created_at', { ascending: true })
        .limit(1);
      
      // Better way:
      const { data: live } = await supabase.from('events').select('slug').eq('status', 'live').limit(1).maybeSingle();
      if (live) {
        setActiveEventSlug(live.slug);
      } else {
        const { data: draft } = await supabase.from('events').select('slug').eq('status', 'draft').limit(1).maybeSingle();
        if (draft) setActiveEventSlug(draft.slug);
      }
    }
    fetchActiveEvent();
  }, []);

  const registerLink = activeEventSlug ? `/register?event=${activeEventSlug}` : '/register';

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <header className="text-center mb-16">
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="inline-block p-3 bg-zinc-900 rounded-2xl mb-6 shadow-xl"
        >
          <Trophy className="w-12 h-12 text-white" />
        </motion.div>
        <h1 className="text-5xl font-black tracking-tight mb-4 uppercase italic">
          Core Elite <span className="text-zinc-500">Combine 2026</span>
        </h1>
        <p className="text-zinc-500 text-lg max-w-xl mx-auto">
          The premier athletic testing environment. Precision data, real-time results, and elite performance tracking.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Link to={registerLink}>
          <motion.div 
            whileHover={{ y: -4 }}
            className="p-8 bg-white rounded-3xl border border-zinc-200 shadow-sm hover:shadow-md transition-all group"
          >
            <Users className="w-10 h-10 text-zinc-900 mb-6 group-hover:scale-110 transition-transform" />
            <h2 className="text-2xl font-bold mb-2">Athlete Registration</h2>
            <p className="text-zinc-500">Register for the event, sign the waiver, and claim your testing wristband.</p>
          </motion.div>
        </Link>

        <Link to="/staff/login">
          <motion.div 
            whileHover={{ y: -4 }}
            className="p-8 bg-white rounded-3xl border border-zinc-200 shadow-sm hover:shadow-md transition-all group"
          >
            <ClipboardCheck className="w-10 h-10 text-zinc-900 mb-6 group-hover:scale-110 transition-transform" />
            <h2 className="text-2xl font-bold mb-2">Staff Station</h2>
            <p className="text-zinc-500">Coach login for recording drill results at testing stations.</p>
          </motion.div>
        </Link>

        <Link to="/admin/login" className="md:col-span-2">
          <motion.div 
            whileHover={{ y: -4 }}
            className="p-8 bg-zinc-900 text-white rounded-3xl shadow-xl hover:shadow-2xl transition-all group"
          >
            <BarChart3 className="w-10 h-10 text-white mb-6 group-hover:scale-110 transition-transform" />
            <h2 className="text-2xl font-bold mb-2">Admin Dashboard</h2>
            <p className="text-zinc-400">Live event monitoring, athlete progress, and station health analytics.</p>
          </motion.div>
        </Link>
      </div>

      <footer className="mt-20 text-center text-zinc-400 text-sm">
        &copy; 2026 Core Elite Athletic Testing. All rights reserved.
      </footer>
    </div>
  );
}
