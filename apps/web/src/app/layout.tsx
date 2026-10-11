import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Sprite } from '@/components/Sprite';
import { Spotlight } from '@/components/Spotlight';
import { X_HANDLE } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://binwise.org'),
  title: 'Binwise',
  description: 'Binwise is an autonomous LP agent for Solana DLMM pools.',
  // The card X, Telegram and others show when someone shares a binwise.org link.
  openGraph: {
    type: 'website',
    siteName: 'Binwise',
    title: 'Binwise: liquidity that manages itself',
    description: 'An autonomous LP agent for Meteora DLMM on Solana. It finds the pools that pay, keeps your liquidity in range and explains every move.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Binwise: liquidity that manages itself' }],
  },
  twitter: {
    card: 'summary_large_image',
    site: X_HANDLE,
    title: 'Binwise: liquidity that manages itself',
    description: 'An autonomous LP agent for Meteora DLMM on Solana. It finds the pools that pay, keeps your liquidity in range and explains every move.',
    images: ['/og.png'],
  },
  // PNG icons too: wallets (Phantom's connect popup) and some browsers don't use SVG favicons.
  icons: {
    icon: [
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
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
