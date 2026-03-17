import React, { useEffect, useRef } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';

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
  disableFlip = false 
}) => {
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  useEffect(() => {
    const scanner = new Html5QrcodeScanner(
      'qr-reader',
      { fps, qrbox, aspectRatio, disableFlip },
      /* verbose= */ false
    );

    scanner.render(
      (decodedText) => {
        onScan(decodedText);
        // scanner.clear(); // Optional: stop scanning after first success
      },
      (error) => {
        // console.warn(error);
      }
    );

    scannerRef.current = scanner;

    return () => {
      if (scannerRef.current) {
        scannerRef.current.clear().catch(err => console.error('Failed to clear scanner', err));
      }
    };
  }, [onScan, fps, qrbox, aspectRatio, disableFlip]);

  return (
    <div className="w-full max-w-md mx-auto overflow-hidden rounded-xl border-2 border-zinc-800 bg-black">
      <div id="qr-reader" className="w-full"></div>
    </div>
  );
};
