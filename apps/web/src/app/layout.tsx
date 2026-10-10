import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Sprite } from '@/components/Sprite';
import { Spotlight } from '@/components/Spotlight';
import './globals.css';

export const metadata: Metadata = {
  title: 'Binwise',
  description: 'Binwise is an autonomous LP agent for Solana DLMM pools.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#07080C',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <div className="grain"></div>
        <Sprite />
        {children}
        <Spotlight />
      </body>
    </html>
  );
}
