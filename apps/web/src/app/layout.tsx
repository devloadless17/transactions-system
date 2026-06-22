import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/lib/query-client';
import { ThemeProvider } from '@/lib/theme-provider';
import { TopProgressBar } from '@/components/top-progress-bar';
import { Toaster } from 'sonner';

export const metadata: Metadata = {
  title: 'Transactions System',
  description: 'Multi-tenant transaction & settlement platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <QueryProvider>
            <TopProgressBar />
            {children}
            {/* Shorter than Sonner's 4s default so success/info toasts dismiss quickly. */}
            <Toaster richColors position="top-right" duration={2500} />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
