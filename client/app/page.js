import { redirect } from 'next/navigation';
export const dynamic = 'force-dynamic';
export default function Home() { redirect(process.env.PUBLIC_DEMO_ENABLED === '1' ? '/demo' : '/app'); }
