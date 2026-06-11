import { redirect } from 'next/navigation';

// Developers moved into the unified Documentation hub (now the Whish Pay tab).
export default function DevelopersPage() {
  redirect('/app/documentation?tab=whish');
}
