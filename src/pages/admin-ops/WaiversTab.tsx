import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { 
  Search, 
  FileText, 
  Download,
  ExternalLink,
  CheckCircle2
} from 'lucide-react';

export function WaiversTab({ eventId }: { eventId: string }) {
  const [waivers, setWaivers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    fetchWaivers();
  }, [eventId]);

  async function fetchWaivers() {
    setLoading(true);
    const { data } = await supabase
      .from('waivers')
      .select('*, athletes(first_name, last_name, parent_email)')
      .eq('event_id', eventId)
      .order('created_at', { ascending: false });
    
    if (data) setWaivers(data);
    setLoading(false);
  }

  const filteredWaivers = waivers.filter(w => 
    `${w.athletes?.first_name} ${w.athletes?.last_name}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
    w.athletes?.parent_email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Waiver Management</h2>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input 
            type="text" 
            placeholder="Search waivers..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-64"
          />
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-100">
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Athlete</th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Guardian</th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Signed Date</th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filteredWaivers.map((waiver) => (
              <tr key={waiver.id} className="hover:bg-zinc-50 transition-colors">
                <td className="px-6 py-4">
                  <div className="font-bold">{waiver.athletes?.first_name} {waiver.athletes?.last_name}</div>
                  <div className="text-xs text-zinc-400">{waiver.athletes?.parent_email}</div>
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm font-medium">{waiver.guardian_name}</div>
                  <div className="text-[10px] text-zinc-400 uppercase font-bold">{waiver.guardian_relationship}</div>
                </td>
                <td className="px-6 py-4 text-xs text-zinc-400">
                  {new Date(waiver.created_at).toLocaleString()}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button 
                      onClick={() => {
                        const win = window.open('', '_blank');
                        win?.document.write(`
                          <html>
                            <body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;background:#f4f4f5;">
                              <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,0.1);max-width:600px;">
                                <h1 style="margin-top:0;">Combine Waiver</h1>
                                <p><strong>Athlete:</strong> ${waiver.athletes?.first_name} ${waiver.athletes?.last_name}</p>
                                <p><strong>Guardian:</strong> ${waiver.guardian_name}</p>
                                <p><strong>Date:</strong> ${new Date(waiver.created_at).toLocaleDateString()}</p>
                                <hr style="border:0;border-top:1px solid #e4e4e7;margin:20px 0;"/>
                                <p style="font-size:14px;color:#71717a;">I release Core Elite from all liability...</p>
                                <div style="margin-top:40px;">
                                  <p style="font-size:12px;color:#a1a1aa;margin-bottom:8px;">Digital Signature:</p>
                                  <img src="${waiver.signature_data_url}" style="max-width:200px;border-bottom:2px solid black;"/>
                                </div>
                              </div>
                            </body>
                          </html>
                        `);
                      }}
                      className="p-2 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg flex items-center gap-2 text-xs font-bold"
                    >
                      <FileText className="w-4 h-4" />
                      View
                    </button>
                    <button className="p-2 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg">
                      <Download className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
