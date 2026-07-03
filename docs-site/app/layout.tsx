import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { appName } from '@/lib/shared';

export const metadata: Metadata = {
  title: {
    template: `%s – ${appName}`,
    default: `${appName} — oversight for a fleet of coding agents`,
  },
  description:
    'glance runs many Oh My Pi coding agents in parallel — one per git worktree — and gives you one place to watch, steer, and land their work.',
};

const inter = Inter({
  subsets: ['latin'],
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
