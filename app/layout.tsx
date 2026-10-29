import './globals.css';
import Pwa from './pwa';
import { Kaushan_Script, Oswald, Alfa_Slab_One, Work_Sans } from 'next/font/google';

const script = Kaushan_Script({ weight: '400', subsets: ['latin'], variable: '--f-script' });
const oswald = Oswald({ weight: ['600', '700'], subsets: ['latin'], variable: '--f-osw' });
const slab = Alfa_Slab_One({ weight: '400', subsets: ['latin'], variable: '--f-slab' });
const work = Work_Sans({ weight: ['400', '500', '600', '700'], subsets: ['latin'], variable: '--f-work' });

export const metadata = {
  title: 'Pancho Esquites',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon-192.png', apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Pancho Esquites', statusBarStyle: 'black-translucent' as const },
  formatDetection: { telephone: false },
};
export const viewport = { themeColor: '#0B0B0C', viewportFit: 'cover' as const, width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="es"><body className={`${script.variable} ${oswald.variable} ${slab.variable} ${work.variable}`}><Pwa />{children}</body></html>;
}
