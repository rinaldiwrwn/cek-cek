import { isAuthed, passwordRequired } from '@/lib/auth';
import { Dashboard, Login } from './ui';

export const dynamic = 'force-dynamic';

export default async function Page() {
  if (await isAuthed()) return <Dashboard />;
  return <Login configured={passwordRequired()} />;
}
