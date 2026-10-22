import './globals.css';
import { Kaushan_Script, Oswald, Alfa_Slab_One, Work_Sans } from 'next/font/google';

const script = Kaushan_Script({ weight: '400', subsets: ['latin'], variable: '--f-script' });
const oswald = Oswald({ weight: ['600', '700'], subsets: ['latin'], variable: '--f-osw' });
const slab = Alfa_Slab_One({ weight: '400', subsets: ['latin'], variable: '--f-slab' });
const work = Work_Sans({ weight: ['400', '500', '600', '700'], subsets: ['latin'], variable: '--f-work' });

export const metadata = { title: 'Pancho Esquites' };
export const viewport = { themeColor: '#4E2C14' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="es"><body className={`${script.variable} ${oswald.variable} ${slab.variable} ${work.variable}`}>{children}</body></html>;
}
