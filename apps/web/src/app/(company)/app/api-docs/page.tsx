import { redirect } from 'next/navigation';

// API Docs moved into the unified Documentation hub (now the Company API tab).
export default function Page() {
  redirect('/app/documentation?tab=company');
}
