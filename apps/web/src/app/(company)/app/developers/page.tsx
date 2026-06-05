import { redirect } from 'next/navigation';

// Developers moved into the unified Documentation hub.
export default function DevelopersPage() {
  redirect('/app/documentation?tab=developers');
}
