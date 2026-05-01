import React, { useEffect, useRef } from 'react';

// `html5-qrcode` ships ~85 KB minified + parses a heavyweight DOM polyfill on
// load. The lib is referenced ONLY inside this component's effect, so we can
// dynamic-import it at mount time. Vite hoists the import into its own chunk
// (`html5-qrcode-*.js`) and ships zero of it on the initial bundle. The default
// export is captured by the runtime once and reused across remounts.
type Html5QrcodeScannerCtor = new (
  elementId: string,
  config: { fps: number; qrbox: number; aspectRatio: number; disableFlip: boolean },
  verbose: boolean,
) => {
  render: (
    onSuccess: (decodedText: string) => void,
    onError: (error: unknown) => void,
  ) => void;
  clear: () => Promise<void>;
};

interface QRScannerProps {
  onScan: (decodedText: string) => void;
  fps?: number;
  qrbox?: number;
  aspectRatio?: number;
  disableFlip?: boolean;
}

export const QRScanner: React.FC<QRScannerProps> = ({
  onScan,
  fps = 10,
  qrbox = 250,
  aspectRatio = 1.0,
  disableFlip = false,
}) => {
  const scannerRef = useRef<{ clear: () => Promise<void> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let active: { clear: () => Promise<void> } | null = null;

    (async () => {
      const mod = await import('html5-qrcode');
      if (cancelled) return;
      const Ctor = (mod as unknown as { Html5QrcodeScanner: Html5QrcodeScannerCtor })
        .Html5QrcodeScanner;
      const scanner = new Ctor(
        'qr-reader',
        { fps, qrbox, aspectRatio, disableFlip },
        false,
      );
      scanner.render(
        (decodedText) => onScan(decodedText),
        () => { /* intentionally ignored — every non-match is a "decode error" */ },
      );
      active = scanner;
      scannerRef.current = scanner;
    })();

    return () => {
      cancelled = true;
      const s = active ?? scannerRef.current;
      if (s) {
        s.clear().catch(err => console.error('Failed to clear scanner', err));
      }
    };
  }, [onScan, fps, qrbox, aspectRatio, disableFlip]);

  return (
    <div className="w-full max-w-md mx-auto overflow-hidden rounded-xl border-2 border-zinc-800 bg-black">
      <div id="qr-reader" className="w-full"></div>
    </div>
  );
};

export default QRScanner;
