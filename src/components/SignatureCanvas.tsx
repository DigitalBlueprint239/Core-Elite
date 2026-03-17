import React, { useRef, useEffect, useState } from 'react';
import SignaturePad from 'signature_pad';
import { AlertCircle } from 'lucide-react';

interface SignatureCanvasProps {
  onSave: (dataUrl: string) => void;
  onClear?: () => void;
}

export const SignatureCanvas: React.FC<SignatureCanvasProps> = ({ onSave, onClear }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signaturePadRef = useRef<SignaturePad | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      signaturePadRef.current = new SignaturePad(canvas);
      
      const resizeCanvas = () => {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext('2d')?.scale(ratio, ratio);
        signaturePadRef.current?.clear();
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
      setLocalError('Signature too short. Please provide a full signature.');
      return;
    }

    setLocalError(null);
    const dataUrl = signaturePadRef.current?.toDataURL();
    if (dataUrl) onSave(dataUrl);
  };

  const handleClear = () => {
    signaturePadRef.current?.clear();
    setLocalError(null);
    if (onClear) onClear();
  };

  return (
    <div className="space-y-4">
      <div className={`border-2 ${localError ? 'border-red-500 bg-red-50/30' : 'border-zinc-200 bg-white'} rounded-lg overflow-hidden h-48 relative transition-colors`}>
        <canvas ref={canvasRef} className="w-full h-full touch-none" />
      </div>
      
      {localError && (
        <div className="flex items-center gap-2 text-red-600 text-xs font-bold animate-in fade-in slide-in-from-top-1">
          <AlertCircle className="w-4 h-4" />
          {localError}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleClear}
          className="flex-1 py-2 px-4 border border-zinc-300 rounded-lg text-zinc-600 font-medium hover:bg-zinc-50 transition-colors"
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
