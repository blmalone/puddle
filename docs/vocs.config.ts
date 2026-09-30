import { defineConfig } from 'vocs/config';
import { brand } from '../scripts/brand.ts';

export default defineConfig({
  title: brand.name,
  description: 'Send to your RAILGUN private balance from any crypto wallet.',
  iconUrl: '/icon.svg',
  colorScheme: 'light dark',
  accentColor: 'light-dark(#5b56e2, #9c98ff)',
  renderStrategy: 'full-static',
  sidebar: [
    { text: 'How it works', link: '/' },
    { text: 'Fees', link: '/fees' },
    { text: 'Recovery', link: '/recovery' },
    { text: 'Contracts & security', link: '/contracts' },
  ],
  topNav: [
    { text: 'App', link: 'http://127.0.0.1:5173', external: true },
    { text: 'GitHub', link: brand.repository, external: true },
  ],
});
