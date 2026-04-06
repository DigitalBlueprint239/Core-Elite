import React, { useRef, useEffect, useState } from 'react';
import SignaturePad from 'signature_pad';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

interface SignatureCanvasProps {
  onSave: (dataUrl: string) => void;
  onClear?: () => void;
}

export const SignatureCanvas: React.FC<SignatureCanvasProps> = ({ onSave, onClear }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signaturePadRef = useRef<SignaturePad | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      signaturePadRef.current = new SignaturePad(canvas, {
        penColor: '#18181b',
      });

      signaturePadRef.current.addEventListener('beginStroke', () => {
        setHasStrokes(true);
        setLocalError(null);
      });

      const resizeCanvas = () => {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext('2d')?.scale(ratio, ratio);
        signaturePadRef.current?.clear();
        setHasStrokes(false);
        setConfirmed(false);
      };

      window.addEventListener('resize', resizeCanvas);
      resizeCanvas();

      return () => window.removeEventListener('resize', resizeCanvas);
    }
  }, []);

  const handleSave = () => {
    if (signaturePadRef.current?.isEmpty()) {
      setLocalError('Signature required — please sign above.');
      return;
    }

    const data = signaturePadRef.current?.toData();
    const pointCount = data?.reduce((acc, stroke) => acc + stroke.points.length, 0) || 0;

    if (pointCount < 10) {
      setLocalError('Please provide a recognizable signature.');
      return;
    }

    setLocalError(null);
    setConfirmed(true);
    const dataUrl = signaturePadRef.current?.toDataURL();
    if (dataUrl) onSave(dataUrl);
  };

  const handleClear = () => {
    signaturePadRef.current?.clear();
    setLocalError(null);
    setHasStrokes(false);
    setConfirmed(false);
    if (onClear) onClear();
  };

  return (
    <div className="space-y-3">
      <div className={`border-2 ${localError ? 'border-red-500 bg-red-50/30' : confirmed ? 'border-emerald-400 bg-emerald-50/20' : 'border-zinc-200 bg-white'} rounded-lg overflow-hidden relative transition-colors`} style={{ minHeight: '160px' }}>
        {!hasStrokes && !confirmed && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
            <span className="text-zinc-300 text-sm font-medium">Sign here</span>
          </div>
        )}
        <canvas ref={canvasRef} className="w-full touch-none" style={{ minHeight: '160px', display: 'block' }} />
      </div>

      {localError && (
        <div className="flex items-center gap-2 text-red-600 text-xs font-bold animate-in fade-in slide-in-from-top-1">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {localError}
        </div>
      )}

      {confirmed && (
        <div className="flex items-center gap-2 text-emerald-600 text-xs font-bold animate-in fade-in slide-in-from-top-1">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Signature captured
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleClear}
          className="flex-1 py-2 px-4 bg-red-100 text-red-600 border border-red-200 rounded-lg font-medium hover:bg-red-200 transition-colors"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="flex-1 py-2 px-4 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Confirm Signature
        </button>
      </div>
    </div>
  );
};
