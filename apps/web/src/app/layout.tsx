import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/lib/query-client';
import { ThemeProvider } from '@/lib/theme-provider';
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
            {children}
            <Toaster richColors position="top-right" />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
