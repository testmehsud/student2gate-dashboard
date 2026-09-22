import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Student2Gate Platform Console',
  description: 'Student2Gate platform-owner dashboard.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
