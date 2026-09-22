import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { LightSource } from '@/components/light-source';

import './stone.css';

export const metadata: Metadata = {
  title: 'Deliverable · Options on tokenized US equity',
  description:
    'Covered calls on real tokenized shares, settled in the share itself. The venue refuses when it cannot defend the state.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light',
  themeColor: '#EFE9DC',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* One family per link: a combined request is a single point of failure for all three. */}
        <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400..900&display=swap" rel="stylesheet" />
        <link
          href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..800;1,400..800&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Martian+Mono:wdth,wght@75..112.5,100..800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        <LightSource />
      </body>
    </html>
  );
}
