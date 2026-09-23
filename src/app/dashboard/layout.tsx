import { redirect } from 'next/navigation';
import { getCurrentPlatformAdmin } from '@/lib/platform-auth';

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const admin = await getCurrentPlatformAdmin();

  if (!admin) {
    redirect('/login');
  }

  return children;
}