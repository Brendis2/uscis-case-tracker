import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = { title: 'Caseway | USCIS case tracker', description: 'A private, clear place to follow your USCIS case.' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
