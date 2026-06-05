import { redirect } from 'next/navigation';

// API Docs moved into the unified Documentation hub.
export default function Page() {
  redirect('/app/documentation?tab=api');
}
